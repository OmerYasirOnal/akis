import { spawn } from 'node:child_process'
import { type Sandbox, scrubEnv } from '../exec/Sandbox.js'
import type { AppType } from './AppDetector.js'
import { installSpec, startSpec, type StartSpec } from './Runner.js'
import { allocatePort, releasePort } from './ports.js'
import { teardown } from './Workspace.js'

/** Env for the long-running preview child — SCRUBBED of AI keys/key-store just like
 *  the Sandbox, so the agent-produced app (the more dangerous child) can't read them. */
export function buildLaunchEnv(spec: StartSpec): Record<string, string> {
  return { ...scrubEnv(process.env), ...spec.env }
}

export type PreviewStatus = 'starting' | 'ready' | 'failed' | 'stopped' | 'unsupported'

export interface PreviewEntry {
  sessionId: string
  status: PreviewStatus
  port?: number
  url?: string        // same-origin proxy path the FE iframe embeds
  dir: string
  type?: AppType      // how it's served — 'static' is served from `dir`, no process/port
  reason?: string
  /** ADDITIVE (review 3399732516): a stable content hash of the materialized RepoFiles this entry
   *  was started from — recorded ONLY on a ready entry. The done-tap/restart path compares the
   *  session's CURRENT code digest against this: equal ⇒ identical bytes ⇒ SKIP the restart (don't
   *  kill an app the user is inspecting nor re-pay npm install for the same code); differ ⇒ restart
   *  (the A3.3 stale-bytes guarantee). Computed by the caller (the route, via verify/digest) and
   *  passed into start() — the registry never imports verify/ (preview↔verify import cycle). */
  digest?: string
}

/** Additive start options (audit P0-2 / review 3399732530 / 3399732516). All optional so existing
 *  callers (and the explicit user POST) keep today's behavior. */
export interface StartOpts {
  /** Content digest of the materialized files (recorded on the ready entry — see PreviewEntry.digest). */
  digest?: string
  /** Capacity policy at the cap. 'allow' (default) = an EXPLICIT user start may evict the oldest
   *  heavy preview (the user asked for THIS one). 'never' = a BACKGROUND start (done-tap restart /
   *  prewarm) DECLINES at capacity instead of evicting — a warm-up is never worth killing a live
   *  preview (review 3399732530 + the cap half of 3399732533). */
  evict?: 'allow' | 'never'
}

/** A launched long-running preview process we can kill and inspect. */
export interface PreviewProc {
  readonly pid?: number
  kill(): void
  /** Last ~8KB of the child's COMBINED stdout+stderr (for diagnostics on a failed/early-exit
   *  launch — many dev servers print the fatal error to stdout, so both are captured). */
  stderrTail?(): string
  /** Resolves with the exit code if/when the child exits BEFORE we kill it (early death). */
  onExit?(cb: (code: number | null) => void): void
}
export type Launch = (spec: StartSpec, cwd: string) => PreviewProc
export type Probe = (port: number) => Promise<boolean>

/** Synthetic verify-boot id marker — defined HERE (verify/previewBoot re-exports it) so the
 *  preview module never imports from verify/ (which imports this file — an import cycle).
 *  Verify boots are EXEMPT from the concurrency cap BOTH ways: never counted, never evicted —
 *  preview pressure can never starve the green gate. */
export const VERIFY_SESSION_SUFFIX = '#verify'

export interface PreviewRegistryDeps {
  sandbox: Sandbox
  launch?: Launch
  probe?: Probe
  onStatus?: (e: PreviewEntry) => void
  installTimeoutMs?: number
  probeAttempts?: number
  probeIntervalMs?: number
  /** Install preflight (does `cmd` resolve on PATH?). Injectable so the lifecycle stays unit-
   *  testable WITHOUT depending on a real pnpm on the test runner's global PATH — the default
   *  spawns the real `<cmd> --version`. (PR #83 review: keep tests host-independent.) */
  commandOnPath?: (cmd: string) => Promise<boolean>
  /** CAP (audit bigger-bet): max CONCURRENT heavy previews (non-static, non-verify dev servers —
   *  150-400MB RSS each; 2-3 of them OOM a small box outright). An EXPLICIT start at the cap
   *  evicts the OLDEST heavy preview (the user asked for THIS one); the auto-prewarm instead
   *  checks {@link PreviewRegistry.atCapacity} and skips. Default 2. */
  maxConcurrent?: number
}

/** A bounded string buffer keeping only the last `max` bytes (ring-trimmed) so capturing
 *  a long-running child's output never grows unbounded. */
function ringBuffer(max = 8 * 1024): { push: (s: string) => void; value: () => string } {
  let buf = ''
  return {
    push: (s: string) => { buf += s; if (buf.length > max) buf = buf.slice(buf.length - max) },
    value: () => buf,
  }
}

/** Real launcher: spawn the start command detached so we can kill its whole group.
 *  stdout AND stderr are PIPED (not ignored) and ring-buffered together to the last ~8KB so a
 *  failed or early-exiting child can surface a useful output tail + exit code (vs. a blank
 *  "readiness probe timed out"). The launch env is scrubEnv'd, so no AI key can be in the tail. */
const defaultLaunch: Launch = (spec, cwd) => {
  const child = spawn(spec.cmd, spec.args, { cwd, env: buildLaunchEnv(spec), detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const err = ringBuffer()
  child.stdout?.on('data', d => err.push(String(d)))
  child.stderr?.on('data', d => err.push(String(d)))
  child.unref()
  const kill = (): void => { const p = child.pid; if (p) { try { process.kill(-p, 'SIGKILL') } catch { try { process.kill(p, 'SIGKILL') } catch { /* gone */ } } } }
  const onExit = (cb: (code: number | null) => void): void => { child.once('exit', code => cb(code)) }
  const stderrTail = (): string => err.value()
  return child.pid !== undefined ? { pid: child.pid, kill, stderrTail, onExit } : { kill, stderrTail, onExit }
}

/** Whether the install runner resolves on PATH — so we can give a clear "enable corepack"
 *  hint instead of the bare "install failed (code null)" when pnpm simply isn't installed.
 *  Spawns `<cmd> --version` directly (no shell): a spawn ENOENT means it isn't on PATH. */
async function commandOnPath(cmd: string): Promise<boolean> {
  const { spawn: sp } = await import('node:child_process')
  return new Promise(res => {
    const p = sp(cmd, ['--version'], { stdio: 'ignore' })
    p.on('error', () => res(false)) // ENOENT etc. → not resolvable
    p.on('close', () => res(true))  // resolved + ran (exit code irrelevant for presence)
  })
}

/** Trim a captured stderr tail for inclusion in a `reason` (last few lines, bounded). */
function tailForReason(tail: string | undefined): string {
  const t = (tail ?? '').trim()
  if (!t) return ''
  const lines = t.split('\n').slice(-8).join('\n')
  return ` — ${lines.slice(-600)}`
}

/** Phase A of the readiness probe: is anything BOUND on the port? A raw TCP connect is far
 *  cheaper than an HTTP request and fails in microseconds while the server is still booting —
 *  so the probe loop wastes no HTTP machinery before the process has even bound the socket. */
const tcpOpen = (port: number): Promise<boolean> => new Promise(res => {
  void import('node:net').then(({ connect }) => {
    const sock = connect({ host: '127.0.0.1', port }, () => { sock.destroy(); res(true) })
    sock.setTimeout(500, () => { sock.destroy(); res(false) })
    // destroy() on the ERROR path too (PR #101 review): probes run in a loop across many
    // sessions — an undestroyed errored socket leaks an FD per failed probe (EMFILE under load).
    sock.on('error', () => { sock.destroy(); res(false) })
  }).catch(() => res(false))
})

/** Real readiness probe, TWO-PHASE (research: probe-hardening): (A) TCP connect — cheap "is it
 *  bound yet"; only then (B) one HTTP GET `/`. ANY HTTP answer < 500 counts as ready — readiness
 *  means "the server answers", not "the app is verified" (the boot-smoke VERIFY probes apply the
 *  stricter <400 rule separately). */
const defaultProbe: Probe = async port => {
  if (!(await tcpOpen(port))) return false
  return new Promise(res => {
    void import('node:http').then(({ get }) => {
      const req = get({ host: '127.0.0.1', port, path: '/', timeout: 1000 }, r => { r.resume(); res((r.statusCode ?? 500) < 500) })
      req.on('error', () => res(false))
      req.on('timeout', () => { req.destroy(); res(false) })
    }).catch(() => res(false))
  })
}

/**
 * Tracks the running preview per session: install deps (sandbox, scripts blocked) →
 * allocate a loopback port → launch the long-running dev/server process → probe
 * readiness → expose a same-origin `/preview/:id` URL. Teardown kills the process
 * group, releases the port, and removes the workspace. launch/probe are injectable
 * so the lifecycle is unit-testable without spawning a real server.
 */
export class PreviewRegistry {
  private entries = new Map<string, PreviewEntry>()
  private procs = new Map<string, PreviewProc>()
  /** Monotonic ownership token per session (audit P0-2). Every call to start() mints a NEW token for
   *  its launch; the async phases of that launch (install → probe-loop → ready) write SHARED state
   *  (this.entries / this.procs) only while their token is STILL the current one for the session. A
   *  launch that was superseded by a newer start() (or a stop()) reads a moved token and STANDS DOWN,
   *  tearing down only its OWN half-made resources (its proc/port/dir) — it never clobbers the newer
   *  launch's entry or untracks its proc. (The post-ready crash-watch already guarded this way via
   *  status+port; this extends the SAME discipline to every async write.) */
  private launchSeq = 0
  private launchToken = new Map<string, number>()
  private launch: Launch
  private probe: Probe
  private commandOnPath: (cmd: string) => Promise<boolean>
  private maxConcurrent: number
  constructor(private deps: PreviewRegistryDeps) {
    this.launch = deps.launch ?? defaultLaunch
    this.probe = deps.probe ?? defaultProbe
    this.commandOnPath = deps.commandOnPath ?? commandOnPath
    this.maxConcurrent = deps.maxConcurrent ?? 2
  }

  /** Heavy = holds (or is about to hold) a dev-server process: live, non-static, not a verify
   *  boot. A 'starting' entry has no type yet — it counts (it is becoming heavy). */
  private countsTowardCap(e: PreviewEntry): boolean {
    return (e.status === 'ready' || e.status === 'starting')
      && e.type !== 'static'
      && !e.sessionId.includes(VERIFY_SESSION_SUFFIX)
  }

  /** True when one MORE heavy preview would exceed the cap — the auto-prewarm checks this and
   *  SKIPS (warming up is never worth evicting something, nor OOMing the box). */
  atCapacity(): boolean {
    return [...this.entries.values()].filter(e => this.countsTowardCap(e)).length >= this.maxConcurrent
  }

  get(sessionId: string): PreviewEntry | undefined { return this.entries.get(sessionId) }

  /** Count of LIVE preview child processes (operational health on /health + /api/ops). Static
   *  previews have NO proc, so they are excluded — this is real load (dev servers holding ports),
   *  not tracked entries. */
  runningCount(): number { return this.procs.size }

  private set(e: PreviewEntry): PreviewEntry { this.entries.set(e.sessionId, e); this.deps.onStatus?.(e); return e }

  /** Does `token` still own this session's launch? (audit P0-2 — guards every async-phase write.)
   *  A newer start() or a stop() bumps the session's token, so a superseded launch reads `false`. */
  private owns(sessionId: string, token: number): boolean {
    return this.launchToken.get(sessionId) === token
  }

  async start(sessionId: string, dir: string, type: AppType, opts: StartOpts = {}): Promise<PreviewEntry> {
    await this.stop(sessionId) // replace any prior preview for this session (also bumps the token)
    // Mint THIS launch's ownership token. Every later write to shared state (this.entries /
    // this.procs) checks owns(token); a superseded launch stands down without clobbering (P0-2).
    const token = ++this.launchSeq
    this.launchToken.set(sessionId, token)

    // Static apps need no install or process: serve the materialized files directly
    // through the proxy. Instant + the smallest attack surface (no agent code runs).
    if (type === 'static') {
      return this.set({ sessionId, status: 'ready', dir, type, url: `/preview/${sessionId}/`, ...(opts.digest ? { digest: opts.digest } : {}) })
    }
    const spec = startSpec(type, 0, sessionId)
    if (!spec) {
      await teardown(dir).catch(() => {})
      if (!this.owns(sessionId, token)) return this.standDownEntry(sessionId)
      return this.set({ sessionId, status: 'unsupported', dir, type, reason: `app type '${type}' not previewable` })
    }

    // CAP enforcement for a heavy start. An EXPLICIT start (evict:'allow', the default — the user
    // asked for THIS one) evicts the OLDEST heavy preview(s) to make room. A BACKGROUND start
    // (evict:'never' — a done-tap restart or prewarm) NEVER evicts: a warm-up is not worth killing
    // someone's live preview, so at capacity it DECLINES (honest 'stopped'+reason). Verify boots
    // bypass the cap entirely — the green gate must never queue behind preview pressure.
    if (!sessionId.includes(VERIFY_SESSION_SUFFIX)) {
      if (opts.evict === 'never') {
        if (this.atCapacity()) {
          await teardown(dir).catch(() => {})
          if (!this.owns(sessionId, token)) return this.standDownEntry(sessionId)
          // Decline without touching ANY other session: leave the prior entry honest. If this very
          // session had a prior entry it was already stop()'d above (its slot freed), so reaching
          // here means OTHER sessions hold the cap — declining protects their live previews.
          return this.set({ sessionId, status: 'stopped', dir, reason: 'preview at capacity — background start declined (a warm-up never evicts a live preview)' })
        }
      } else {
        while (this.atCapacity()) {
          const oldest = [...this.entries.values()].find(e => this.countsTowardCap(e))
          if (!oldest) break
          await this.stop(oldest.sessionId)
        }
      }
    }
    // A newer launch (or a stop) for THIS session may have landed during the eviction awaits above —
    // don't clobber its 'starting'/'ready' with our stale frame. (P0-2: guard every write.)
    if (!this.owns(sessionId, token)) return this.standDownEntry(sessionId)
    this.set({ sessionId, status: 'starting', dir })
    const install = installSpec()
    // Install preflight: a missing pnpm yields a bare "code null" — give an actionable hint.
    if (!(await this.commandOnPath(install.cmd))) {
      await teardown(dir).catch(() => {})
      // owns-guard: a launch superseded mid-preflight stands down silently (no clobber).
      if (!this.owns(sessionId, token)) return this.standDownEntry(sessionId)
      return this.set({ sessionId, status: 'failed', dir, reason: `${install.cmd} not found — enable corepack (corepack enable)` })
    }
    const res = await this.deps.sandbox.run(install.cmd, install.args, { cwd: dir, timeoutMs: this.deps.installTimeoutMs ?? 120_000 })
    if (res.code !== 0) {
      await teardown(dir).catch(() => {})
      if (!this.owns(sessionId, token)) return this.standDownEntry(sessionId)
      // Surface the captured install stderr tail (previously captured then discarded).
      return this.set({ sessionId, status: 'failed', dir, reason: `install failed (code ${res.code})${tailForReason(res.stderr)}` })
    }

    const port = await allocatePort()
    // A launch superseded during install must NOT register its proc under the session key (it would
    // untrack/overwrite the newer launch's proc). Stand down: don't launch, release the port, tear
    // down our own dir. (P0-2: only our OWN half-made resources.)
    if (!this.owns(sessionId, token)) { releasePort(port); await teardown(dir).catch(() => {}); return this.standDownEntry(sessionId) }
    const proc = this.launch(startSpec(type, port, sessionId)!, dir)
    this.procs.set(sessionId, proc)

    // Watch for an early death: if the child exits before readiness, FAIL FAST with its exit
    // code + a stderr tail instead of burning the whole probe budget on a dead process.
    let earlyExit: { code: number | null } | undefined
    proc.onExit?.(code => { earlyExit = { code } })

    const attempts = this.deps.probeAttempts ?? (Number(process.env.AKIS_PREVIEW_PROBE_ATTEMPTS) || 60)
    const interval = this.deps.probeIntervalMs ?? 250
    // Total budget keeps the attempts×interval CONTRACT (tests configure both), but the wait
    // between probes grows exponentially (capped at 4× the base): early probes are tight so a
    // fast Express/vite boot is detected in ~100-500ms, late ones back off so a slow `next dev`
    // boot isn't hammered — same budget, fewer wasted cycles (research: probe-hardening).
    const budgetMs = attempts * interval
    const started = Date.now()
    let delay = interval
    for (;;) {
      // SUPERSEDED mid-probe (a newer start() or a stop() took the token): stand down. Kill OUR
      // OWN proc + release OUR port + tear OUR dir — but never touch this.procs/this.entries (the
      // newer launch owns those now). (P0-2 core.)
      if (!this.owns(sessionId, token)) {
        proc.kill(); releasePort(port); await teardown(dir).catch(() => {})
        return this.standDownEntry(sessionId)
      }
      if (earlyExit) {
        releasePort(port)
        await teardown(dir).catch(() => {})
        // Re-check ownership AFTER the teardown await (mirrors the timeout branch): a stop()/newer
        // start() landing in this window must NOT be clobbered back to 'failed', and we must not
        // untrack a newer launch's proc. Stand down if superseded. (P0-2.)
        if (!this.owns(sessionId, token)) return this.standDownEntry(sessionId)
        this.procs.delete(sessionId)
        return this.set({ sessionId, status: 'failed', dir, port, reason: `preview process exited early (code ${earlyExit.code})${tailForReason(proc.stderrTail?.())}` })
      }
      if (await this.probe(port)) {
        // Re-check ownership AFTER the await: a stop()/newer start() may have landed while probing.
        if (!this.owns(sessionId, token)) {
          proc.kill(); releasePort(port); await teardown(dir).catch(() => {})
          return this.standDownEntry(sessionId)
        }
        // POST-READY crash watch (caught LIVE): a generated server that crashes on a later
        // request used to leave a STALE 'ready' entry — the proxy answered 502 "preview
        // unavailable" with no reason and no recovery hint. Flip the entry to 'failed' with
        // the exit code + stderr tail (the preview_status event reaches the UI), release the
        // port and tear the workspace down. Guard: only if THIS launch still owns the session
        // AND its entry is still this run's 'ready' (a stop()/restart in between must not be
        // overwritten). The token check subsumes the old status+port check but we keep both
        // (defense in depth: the entry could have been re-set to ready by a same-port future run).
        proc.onExit?.(code => {
          if (!this.owns(sessionId, token)) return
          const cur = this.entries.get(sessionId)
          if (cur?.status !== 'ready' || cur.port !== port) return
          releasePort(port); this.procs.delete(sessionId)
          void teardown(dir).catch(() => {})
          this.set({ sessionId, status: 'failed', dir, port, reason: `preview crashed after start (code ${code})${tailForReason(proc.stderrTail?.())}` })
        })
        return this.set({ sessionId, status: 'ready', dir, port, url: `/preview/${sessionId}/`, ...(opts.digest ? { digest: opts.digest } : {}) })
      }
      if (Date.now() - started >= budgetMs) break
      await new Promise(r => setTimeout(r, Math.min(delay, budgetMs - (Date.now() - started))))
      delay = Math.min(delay * 1.5, interval * 4)
    }
    proc.kill(); releasePort(port)
    await teardown(dir).catch(() => {})
    // Probe-timeout: a superseded launch stands down (its kill+release above already cleaned up its
    // own proc/port); only the owner writes the 'failed' entry + untracks its proc.
    if (!this.owns(sessionId, token)) return this.standDownEntry(sessionId)
    this.procs.delete(sessionId)
    return this.set({ sessionId, status: 'failed', dir, port, reason: `readiness probe timed out${tailForReason(proc.stderrTail?.())}` })
  }

  /** A superseded launch's return value: the CURRENT (newer) entry for the session, untouched. The
   *  superseded launch has already torn down its OWN resources; it returns whatever the owner set
   *  (or a benign 'stopped' shell if there is none yet) WITHOUT writing to the maps. (P0-2.) */
  private standDownEntry(sessionId: string): PreviewEntry {
    return this.entries.get(sessionId) ?? { sessionId, status: 'stopped', dir: '', reason: 'superseded by a newer preview start' }
  }

  async stop(sessionId: string): Promise<void> {
    // Bump the token so any in-flight launch for this session is SUPERSEDED and stands down — a
    // stop() must win against a concurrent start()'s late writes (P0-2: a Stop is authoritative).
    this.launchToken.set(sessionId, ++this.launchSeq)
    const proc = this.procs.get(sessionId)
    if (proc) { proc.kill(); this.procs.delete(sessionId) }
    const e = this.entries.get(sessionId)
    if (e?.port !== undefined) releasePort(e.port)
    if (e) { this.set({ ...e, status: 'stopped' }); await teardown(e.dir).catch(() => {}) }
  }

  /**
   * Stop EVERY tracked preview (graceful shutdown): kill each process group, release its
   * port, tear down its workspace, emit 'stopped'. Per-entry errors are tolerated
   * (Promise.allSettled) so one stuck preview can't block a clean server shutdown. Covers
   * both live procs and any tracked entry (e.g. a static preview with no proc).
   */
  async stopAll(): Promise<void> {
    const ids = new Set<string>([...this.entries.keys(), ...this.procs.keys()])
    await Promise.allSettled([...ids].map(id => this.stop(id)))
  }

  /** Port for a session's ready preview (for the proxy upstream). */
  portFor(sessionId: string): number | undefined {
    const e = this.entries.get(sessionId)
    return e?.status === 'ready' ? e.port : undefined
  }

  /** Materialized dir for a ready STATIC preview (served from disk, no port). */
  staticDirFor(sessionId: string): string | undefined {
    const e = this.entries.get(sessionId)
    return e?.status === 'ready' && e.type === 'static' ? e.dir : undefined
  }
}
