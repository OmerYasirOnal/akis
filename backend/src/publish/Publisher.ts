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

    // 7. Push the app files.
    await transport.putFiles(input.files, targetDir)

    if (appType === 'static') {
      // Ship the vendored static server alongside the files; start it bound to 0.0.0.0.
      await transport.putFiles([{ filePath: 'static-serve.mjs', content: STATIC_SERVE_MJS }], targetDir)
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
      await transport.putFiles([{ filePath: 'run.sh', content: runSh }], targetDir)
      const start = await runStep(
        `cd "${targetDir}" && chmod +x run.sh && nohup bash run.sh >run.log 2>&1 & echo $! >run.pid; true`,
        'start node service',
      )
      if (!start) return { ok: false, url, at, appType, logTail: log.value() }
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
