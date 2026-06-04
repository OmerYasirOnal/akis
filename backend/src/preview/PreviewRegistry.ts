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
  private launch: Launch
  private probe: Probe
  private commandOnPath: (cmd: string) => Promise<boolean>
  constructor(private deps: PreviewRegistryDeps) {
    this.launch = deps.launch ?? defaultLaunch
    this.probe = deps.probe ?? defaultProbe
    this.commandOnPath = deps.commandOnPath ?? commandOnPath
  }

  get(sessionId: string): PreviewEntry | undefined { return this.entries.get(sessionId) }

  private set(e: PreviewEntry): PreviewEntry { this.entries.set(e.sessionId, e); this.deps.onStatus?.(e); return e }

  async start(sessionId: string, dir: string, type: AppType): Promise<PreviewEntry> {
    await this.stop(sessionId) // replace any prior preview for this session
    // Static apps need no install or process: serve the materialized files directly
    // through the proxy. Instant + the smallest attack surface (no agent code runs).
    if (type === 'static') {
      return this.set({ sessionId, status: 'ready', dir, type, url: `/preview/${sessionId}/` })
    }
    const spec = startSpec(type, 0, sessionId)
    if (!spec) { await teardown(dir).catch(() => {}); return this.set({ sessionId, status: 'unsupported', dir, type, reason: `app type '${type}' not previewable` }) }

    this.set({ sessionId, status: 'starting', dir })
    const install = installSpec()
    // Install preflight: a missing pnpm yields a bare "code null" — give an actionable hint.
    if (!(await this.commandOnPath(install.cmd))) {
      await teardown(dir).catch(() => {})
      return this.set({ sessionId, status: 'failed', dir, reason: `${install.cmd} not found — enable corepack (corepack enable)` })
    }
    const res = await this.deps.sandbox.run(install.cmd, install.args, { cwd: dir, timeoutMs: this.deps.installTimeoutMs ?? 120_000 })
    if (res.code !== 0) {
      await teardown(dir).catch(() => {})
      // Surface the captured install stderr tail (previously captured then discarded).
      return this.set({ sessionId, status: 'failed', dir, reason: `install failed (code ${res.code})${tailForReason(res.stderr)}` })
    }

    const port = await allocatePort()
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
      if (earlyExit) {
        releasePort(port); this.procs.delete(sessionId)
        await teardown(dir).catch(() => {})
        return this.set({ sessionId, status: 'failed', dir, port, reason: `preview process exited early (code ${earlyExit.code})${tailForReason(proc.stderrTail?.())}` })
      }
      if (await this.probe(port)) {
        // POST-READY crash watch (caught LIVE): a generated server that crashes on a later
        // request used to leave a STALE 'ready' entry — the proxy answered 502 "preview
        // unavailable" with no reason and no recovery hint. Flip the entry to 'failed' with
        // the exit code + stderr tail (the preview_status event reaches the UI), release the
        // port and tear the workspace down. Guard: only if the entry is STILL this run's
        // 'ready' (a stop()/restart in between must not be overwritten).
        proc.onExit?.(code => {
          const cur = this.entries.get(sessionId)
          if (cur?.status !== 'ready' || cur.port !== port) return
          releasePort(port); this.procs.delete(sessionId)
          void teardown(dir).catch(() => {})
          this.set({ sessionId, status: 'failed', dir, port, reason: `preview crashed after start (code ${code})${tailForReason(proc.stderrTail?.())}` })
        })
        return this.set({ sessionId, status: 'ready', dir, port, url: `/preview/${sessionId}/` })
      }
      if (Date.now() - started >= budgetMs) break
      await new Promise(r => setTimeout(r, Math.min(delay, budgetMs - (Date.now() - started))))
      delay = Math.min(delay * 1.5, interval * 4)
    }
    proc.kill(); releasePort(port); this.procs.delete(sessionId)
    await teardown(dir).catch(() => {})
    return this.set({ sessionId, status: 'failed', dir, port, reason: `readiness probe timed out${tailForReason(proc.stderrTail?.())}` })
  }

  async stop(sessionId: string): Promise<void> {
    const proc = this.procs.get(sessionId)
    if (proc) { proc.kill(); this.procs.delete(sessionId) }
    const e = this.entries.get(sessionId)
    if (e?.port !== undefined) releasePort(e.port)
    if (e) { this.set({ ...e, status: 'stopped', ...(e.port !== undefined ? {} : {}) }); await teardown(e.dir).catch(() => {}) }
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
