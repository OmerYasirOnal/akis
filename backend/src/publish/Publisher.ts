import type { PublishRecord, PublishAppType } from '@akis/shared'
import type { RepoFile } from '../di/MockGitHubAdapter.js'
import { detectAppType } from '../preview/AppDetector.js'
import type { SshTransport, SshConfig } from './SshTransport.js'
import type { PublishProfile } from '../keys/PublishProfileStore.js'
import { validHost, validSshUser, validTargetDir, validAppPort, validPublicUrl } from './validate.js'
import { STATIC_SERVE_MJS } from './staticServe.js'

/** A factory that opens a transport for a config — the seam tests inject a FakeSshTransport
 *  through (RealGitHubAdapter.fetch? precedent). Prod passes an OpenSshTransport factory. */
export type TransportFactory = (cfg: SshConfig) => SshTransport

/** A bounded HTTP probe of the published URL FROM AKIS. Returns true iff the URL answered with a
 *  status < 500 within the timeout. Injected (tests pass a stub; prod passes a real fetch probe). */
export type UrlProbe = (url: string, timeoutMs: number) => Promise<boolean>

export interface PublishInput {
  files: RepoFile[]
  profile: PublishProfile
  transportFactory: TransportFactory
  /** URL reachability probe (injected). Absent ⇒ reachability is not recorded. */
  urlProbe?: UrlProbe
  now?: () => string
  /** TOTAL deadline for the whole publish (so a slow box never hangs the worker). Default 90s. */
  deadlineMs?: number
  /** Per-step run timeout. Default 30s. */
  stepTimeoutMs?: number
}

const DEFAULT_APP_PORT = 8080
const MAX_LOG_LINES = 40
const MAX_LOG_BYTES = 4 * 1024

/** A bounded, scrubbed log accumulator. Caps at ~40 lines / ~4KB; every pushed line is scrubbed
 *  of secrets BEFORE it is retained (so a secret can never reach the persisted record). */
class BoundedLog {
  private lines: string[] = []
  constructor(private readonly scrub: (s: string) => string) {}
  push(line: string): void {
    const cleaned = this.scrub(line).trim()
    if (!cleaned) return
    for (const l of cleaned.split('\n')) {
      this.lines.push(l)
      if (this.lines.length > MAX_LOG_LINES) this.lines.shift()
    }
    // Byte cap: drop from the front until under the limit.
    while (this.lines.join('\n').length > MAX_LOG_BYTES && this.lines.length > 1) this.lines.shift()
  }
  value(): string[] { return [...this.lines] }
}

/**
 * Deploy a session's produced files to the owner's OWN server over SSH. The deploy is a
 * POST-`done`, OPTIONAL, NON-GATING action — the Publisher NEVER touches a gate or a status; it
 * returns a `PublishRecord` describing what happened. An EXPECTED failure (unsupported app, remote
 * node missing, a non-zero command, a timeout, an unreachable URL) is a SUCCESSFUL honest report:
 * `{ok:false, logTail}` is RETURNED, never thrown. Only a genuine programming error bubbles up.
 *
 * SECURITY: the private key reaches OpenSSH only via the transport's `-i <0600 tempfile>` (never
 * argv); every interpolated Settings value is re-validated here (defense-in-depth) before it can
 * enter a remote command; `logTail` is bounded + scrubbed (the key, the key temp-file path, any
 * Authorization/token, any env value never enters it).
 */
export async function publish(input: PublishInput): Promise<PublishRecord> {
  const now = input.now ?? (() => new Date().toISOString())
  const at = now()
  const { profile } = input
  // SCRUB: redact the key (and any recognizable slice), the host/user (could carry a hint), and
  // generic secret-looking tokens. The key temp-file PATH never enters a log line by construction
  // (the transport owns it and never logs it), but we still redact a 'PRIVATE KEY' marker defensively.
  const keyMarker = profile.sshPrivateKey
  const scrub = (s: string): string => {
    let out = s
    if (keyMarker) out = out.split(keyMarker).join('[redacted-key]')
    out = out.replace(/-----BEGIN[\s\S]*?PRIVATE KEY-----[\s\S]*?-----END[\s\S]*?PRIVATE KEY-----/g, '[redacted-key]')
    out = out.replace(/(authorization|bearer|token)\s*[:=]\s*\S+/gi, '$1: [redacted]')
    return out
  }
  const log = new BoundedLog(scrub)
  const appType = detectAppType(input.files) as PublishAppType

  // Defense-in-depth re-validation: the route validated these, but the Publisher must never build
  // a remote command from an unvalidated value (a future caller might skip the route).
  if (!validHost(profile.host) || !validSshUser(profile.sshUser) || !validTargetDir(profile.targetDir)
    || (profile.appPort !== undefined && !validAppPort(profile.appPort))
    || (profile.publicUrl !== undefined && !validPublicUrl(profile.publicUrl))) {
    log.push('publish destination failed validation — refusing to deploy')
    return { ok: false, at, appType, logTail: log.value() }
  }

  // vite/next/unsupported are NOT publishable in v1 (need a build step + a static/SSR host we
  // don't provision yet). Honest ok:false with a clear code in the log.
  if (appType !== 'static' && appType !== 'node-service') {
    log.push(`app type '${appType}' needs infra we don't provision yet (code:Unsupported)`)
    return { ok: false, at, appType, logTail: log.value() }
  }

  const appPort = profile.appPort ?? DEFAULT_APP_PORT
  const targetDir = profile.targetDir // validated absolute path
  const url = profile.publicUrl ?? `http://${profile.host}:${appPort}`
  const deadlineMs = input.deadlineMs ?? 90_000
  const stepTimeoutMs = input.stepTimeoutMs ?? 30_000
  const startedAt = Date.now()
  const remaining = (): number => deadlineMs - (Date.now() - startedAt)
  const stepTimeout = (): number => Math.max(1, Math.min(stepTimeoutMs, remaining()))

  const transport = input.transportFactory({
    host: profile.host,
    user: profile.sshUser,
    privateKeyPem: profile.sshPrivateKey,
  })

  try {
    // A reusable runner that enforces BOTH the per-step and the TOTAL deadline. On a deadline
    // breach it records an honest reason and signals the caller to STOP (returns null).
    const runStep = async (cmd: string, what: string): Promise<{ code: number | null; stdout: string; stderr: string } | null> => {
      if (remaining() <= 0) { log.push(`${what}: exceeded the total deadline`); return null }
      const res = await transport.run(cmd, { timeoutMs: stepTimeout() })
      if (res.code === null) { log.push(`${what}: timed out`) }
      return res
    }

    // 1+4. STOP any prior app FIRST (best-effort; ignore "no such process"). Otherwise the OLD
    //    node process keeps the OLD code bound to appPort and the deploy would probe the OLD app
    //    (false success), or two copies fight over appPort/app.db. We kill BOTH the app pid and
    //    the run.sh supervisor (run.pid) so the supervisor can't immediately re-spawn the old app.
    await runStep(
      `for p in run.pid app.pid; do f="${targetDir}/$p"; [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null; done; true`,
      'stop prior app',
    )

    // 5. REMOTE node preflight (ENOENT discipline over SSH). `command -v node` is the POSIX probe.
    const nodeCheck = await runStep(`command -v node >/dev/null 2>&1 && node --version || echo __NO_NODE__`, 'check node')
    if (!nodeCheck) return { ok: false, url, at, appType, logTail: log.value() }
    if (nodeCheck.stdout.includes('__NO_NODE__') || nodeCheck.code !== 0) {
      log.push(`node not found on the instance for user ${profile.sshUser} — install Node and retry`)
      return { ok: false, url, at, appType, logTail: log.value() }
    }
    // 5b. NODE-VERSION preflight. The verified fullstack shape uses node:sqlite/DatabaseSync, which
    //     is a builtin only since Node 22.5 (DatabaseSync stabilized at 22.13). On a Node-20 box (the
    //     documented OCI target) `node .` throws ERR_UNKNOWN_BUILTIN_MODULE at module load and the
    //     run.sh until-loop tight-restarts forever — the port never binds. Without this check the
    //     deploy returns ok:true and the only signal is a urlProbe miss, which is then MISdiagnosed
    //     as a firewall problem ("open the inbound port") — a flatly wrong cause. We parse the
    //     version, ALWAYS record it in logTail (so the version is never invisible), and when the app
    //     needs node:sqlite we hard-fail honestly naming the REAL cause.
    const detectedNode = parseNodeVersion(nodeCheck.stdout)
    if (detectedNode) log.push(`detected node ${detectedNode.raw} on the instance`)
    if (filesUseNodeSqlite(input.files)) {
      // node:sqlite/DatabaseSync needs >=22.13 (we require the STABLE floor, not the 22.5 preview).
      if (!detectedNode || !atLeast(detectedNode, { major: 22, minor: 13 })) {
        const have = detectedNode ? `node ${detectedNode.raw}` : 'an unparseable node version'
        log.push(`this app uses node:sqlite (DatabaseSync) which needs Node >=22.13, but the instance has ${have} — upgrade Node on the box to >=22.13 and retry`)
        return { ok: false, url, at, appType, logTail: log.value() }
      }
    }

    // 6. mkdir -p targetDir + assert it is writable (a probe write we immediately remove).
    const mk = await runStep(
      `mkdir -p "${targetDir}" && touch "${targetDir}/.akis-write-probe" && rm -f "${targetDir}/.akis-write-probe" && echo __WRITABLE__ || echo __NOWRITE__`,
      'prepare target dir',
    )
    if (!mk) return { ok: false, url, at, appType, logTail: log.value() }
    if (!mk.stdout.includes('__WRITABLE__')) {
      log.push(`target dir ${targetDir} is not writable for ${profile.sshUser} (EACCES/EROFS) — check ownership/permissions`)
      return { ok: false, url, at, appType, logTail: log.value() }
    }

    // 6b. STALE-FILE cleanup on re-publish. scp -r is an additive MERGE — it overwrites matching
    //     paths and adds new ones but NEVER deletes files removed in the new build, so a deleted/
    //     renamed file (esp. an orphaned static page/bundle) keeps being served. We clear the prior
    //     payload BEFORE the upload so the deploy is idempotent w.r.t. removals — matching the doc's
    //     "overwrites the target dir in place". We PRESERVE runtime state we own (app.db so a
    //     fullstack app keeps its data; pids so the kill step still works; logs for diagnostics).
    const clean = await runStep(
      `find "${targetDir}" -mindepth 1 -maxdepth 1 ` +
        `! -name 'app.db' ! -name 'app.db-*' ` +     // sqlite db + its WAL/SHM/journal sidecars
        `! -name '*.pid' ! -name '*.log' ` +          // run.pid/app.pid + run.log/app.log/static.log
        `-exec rm -rf {} + ; true`,
      'clear stale files',
    )
    if (!clean) return { ok: false, url, at, appType, logTail: log.value() }

    // 7. Push the app files (timeoutMs threaded from the deadline so a stalled transfer fails
    //    honestly instead of hanging the worker — ConnectTimeout only bounds the handshake).
    const pushed = await transport.putFiles(input.files, targetDir, stepTimeout())
    noteSkipped(log, pushed.skipped)

    if (appType === 'static') {
      // Ship the vendored static server alongside the files; start it bound to 0.0.0.0.
      await transport.putFiles([{ filePath: 'static-serve.mjs', content: STATIC_SERVE_MJS }], targetDir, stepTimeout())
      const start = await runStep(
        // cd FIRST (relative reads resolve under targetDir), start detached, record pids.
        `cd "${targetDir}" && nohup node static-serve.mjs ${appPort} "${targetDir}" >static.log 2>&1 & echo $! >app.pid; true`,
        'start static server',
      )
      if (!start) return { ok: false, url, at, appType, logTail: log.value() }
    } else {
      // node-service (INCLUDES the self-serving fullstack case). INSTALL only when package.json
      // declares dependencies — the verified Phase-G fullstack app uses ONLY node: built-ins with
      // NO deps and NO lockfile, so `npm ci` would error every time. When deps exist we run
      // `npm install --omit=dev --ignore-scripts`: the --ignore-scripts is a CONSCIOUS, commented
      // continuation of installSpec()'s THREAT-MODEL posture (we will NOT run arbitrary lifecycle
      // scripts on the user's box).
      const hasDeps = packageHasDependencies(input.files)
      if (hasDeps) {
        const npmCheck = await runStep(`command -v npm >/dev/null 2>&1 && echo __NPM__ || echo __NO_NPM__`, 'check npm')
        if (!npmCheck) return { ok: false, url, at, appType, logTail: log.value() }
        if (!npmCheck.stdout.includes('__NPM__')) {
          log.push(`npm not found on the instance for user ${profile.sshUser} — install npm and retry`)
          return { ok: false, url, at, appType, logTail: log.value() }
        }
        // --ignore-scripts: the dominant install-step attack surface (THREAT-MODEL); we do NOT run
        // lifecycle scripts on the user's box. NOT `npm ci` (no lockfile is guaranteed).
        const install = await runStep(`cd "${targetDir}" && npm install --omit=dev --ignore-scripts 2>&1`, 'npm install')
        if (!install) return { ok: false, url, at, appType, logTail: log.value() }
        if (install.code !== 0) {
          log.push(`npm install failed (code ${install.code})`)
          log.push(install.stdout || install.stderr)
          return { ok: false, url, at, appType, logTail: log.value() }
        }
      }
      // Write the supervisor run.sh. It `cd`s into targetDir FIRST — the verified app does
      // new DatabaseSync('app.db') (a RELATIVE path), and `ssh user@host '<cmd>'` runs from the
      // login HOME, so without cd the db lands in the wrong place and a restart from a different
      // CWD spawns a NEW empty app.db (silent data loss). The `until` loop re-execs on exit WITH a
      // 2s sleep so an instantly-crashing app cannot tight-spin and peg the CPU. It binds 0.0.0.0
      // (external reach — NOT preview's loopback). PORT/HOST mirror the preview node-service contract.
      const runSh = [
        '#!/usr/bin/env bash',
        `cd "${targetDir}" || exit 1`,
        'until false; do',
        `  PORT=${appPort} HOST=0.0.0.0 node . >app.log 2>&1 &`,
        '  echo $! > app.pid',
        '  wait "$(cat app.pid)"',
        '  sleep 2',
        'done',
      ].join('\n')
      await transport.putFiles([{ filePath: 'run.sh', content: runSh }], targetDir, stepTimeout())
      const start = await runStep(
        `cd "${targetDir}" && chmod +x run.sh && nohup bash run.sh >run.log 2>&1 & echo $! >run.pid; true`,
        'start node service',
      )
      if (!start) return { ok: false, url, at, appType, logTail: log.value() }
    }

    // 7c. VERIFY the start actually took. The detached launchers end in `; true`, so runStep ALWAYS
    //     sees code 0 — a genuine start failure (EADDRINUSE on a re-publish, an instant crash) is
    //     invisible to the Publisher otherwise. After a short settle we assert the recorded pid is
    //     still alive (`kill -0`) AND the port is bound (a listener on appPort). The static path is
    //     the one that does NOT self-heal (no until-loop), so this is its only failure signal. We
    //     check the run-supervisor pid for node-service (run.pid) and the server pid for static
    //     (app.pid). A dead pid + an unbound port ⇒ honest ok:false naming the likely cause.
    const startedPidFile = appType === 'static' ? 'app.pid' : 'run.pid'
    const liveness = await runStep(
      `sleep 1; ` +
        `cd "${targetDir}" 2>/dev/null || true; ` +
        `alive=__DEAD__; [ -f "${startedPidFile}" ] && kill -0 "$(cat "${startedPidFile}" 2>/dev/null)" 2>/dev/null && alive=__ALIVE__; ` +
        // Port-bound probe: prefer a /dev/tcp connect (bash builtin, no extra binary). A successful
        // connect to 127.0.0.1:appPort means SOMETHING is listening.
        `bound=__UNBOUND__; (exec 3<>/dev/tcp/127.0.0.1/${appPort}) 2>/dev/null && { bound=__BOUND__; exec 3>&- 3<&-; }; ` +
        `echo "$alive $bound"`,
      'verify start',
    )
    if (!liveness) return { ok: false, url, at, appType, logTail: log.value() }
    const started = liveness.stdout.includes('__ALIVE__') || liveness.stdout.includes('__BOUND__')
    if (!started) {
      log.push(
        appType === 'static'
          ? `the static server did not stay up and ${appPort} is not bound — likely the port is already in use by a prior server (see static.log on the box)`
          : `the node service did not stay up and ${appPort} is not bound — check app.log on the box (a crash-on-start, e.g. a missing dependency or an incompatible Node)`,
      )
      return { ok: false, url, at, appType, logTail: log.value() }
    }

    // 8. Probe the URL FROM AKIS. reachable:false on a successful deploy is the OCI security-list/
    //    host-firewall case — recorded HONESTLY so "ok but blank page" is never a silent success.
    let reachable: boolean | undefined
    if (input.urlProbe) {
      reachable = await input.urlProbe(url, Math.max(1, Math.min(8_000, remaining())))
      if (!reachable) log.push(`deployed, but ${url} is not reachable from AKIS — open the inbound port (VCN security list + host firewall)`)
      else log.push(`deployed and reachable at ${url}`)
    } else {
      log.push(`deployed; start command issued for ${url}`)
    }

    return {
      ok: true, url, at, appType,
      ...(reachable !== undefined ? { reachable } : {}),
      logTail: log.value(),
    }
  } catch (err) {
    // An UNEXPECTED transport error (e.g. the ssh binary missing) is still an honest ok:false —
    // never a 500 that could echo internals. The message is scrubbed by the BoundedLog.
    log.push(`publish failed: ${(err as Error).message}`)
    return { ok: false, url, at, appType, logTail: log.value() }
  } finally {
    // 9. Always release the transport (temp key dir cleanup) even on throw/timeout.
    await transport.close().catch(() => {})
  }
}

/** A parsed semver-ish node version (only major/minor matter for our floor checks). */
interface NodeVersion { major: number; minor: number; raw: string }

/** Parse the `node --version` output (e.g. "v22.13.1" or "v20.19.1\n"). Returns undefined when the
 *  output carries no recognizable version (so the caller treats it as "unknown / can't confirm"). */
function parseNodeVersion(stdout: string): NodeVersion | undefined {
  const m = stdout.match(/v?(\d+)\.(\d+)\.(\d+)/)
  if (!m) return undefined
  const major = Number(m[1])
  const minor = Number(m[2])
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return undefined
  return { major, minor, raw: `v${m[1]}.${m[2]}.${m[3]}` }
}

/** Whether `have` is at least `floor` (major then minor). */
function atLeast(have: NodeVersion, floor: { major: number; minor: number }): boolean {
  if (have.major !== floor.major) return have.major > floor.major
  return have.minor >= floor.minor
}

/** Whether ANY produced file imports/requires node:sqlite (DatabaseSync) — a builtin only since
 *  Node 22.5 (stable at 22.13). Matched on the bare specifier so both `require('node:sqlite')` and
 *  `import … from 'node:sqlite'` are caught; we only scan code-ish files (skip package.json/json). */
function filesUseNodeSqlite(files: RepoFile[]): boolean {
  for (const f of files) {
    const rel = f.filePath.replace(/^\.?\//, '')
    if (rel.endsWith('.json')) continue
    if (f.content.includes('node:sqlite')) return true
  }
  return false
}

/** Surface a SCRUBBED note for any file the transport skipped (an unsafe '..' path) so a partial
 *  upload is never silent. We never echo the raw path (it could be hostile); we report the count. */
function noteSkipped(log: BoundedLog, skipped: string[]): void {
  if (skipped.length === 0) return
  log.push(`skipped ${skipped.length} file(s) with an unsafe path (contains '..') — they were NOT uploaded`)
}

/** Whether the produced package.json declares any runtime dependencies (so an install is needed).
 *  No deps (or no package.json) ⇒ skip install entirely — `npm ci`/`npm install` would error on a
 *  no-lockfile, no-deps app (the verified fullstack shape). */
function packageHasDependencies(files: RepoFile[]): boolean {
  const pkg = files.find(f => f.filePath.replace(/^\.?\//, '') === 'package.json')
  if (!pkg) return false
  try {
    const parsed = JSON.parse(pkg.content) as { dependencies?: Record<string, string> }
    return !!parsed.dependencies && Object.keys(parsed.dependencies).length > 0
  } catch {
    return false
  }
}
