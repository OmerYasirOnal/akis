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
  reason?: string
}

/** A launched long-running preview process we can kill. */
export interface PreviewProc { readonly pid?: number; kill(): void }
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
}

/** Real launcher: spawn the start command detached so we can kill its whole group. */
const defaultLaunch: Launch = (spec, cwd) => {
  const child = spawn(spec.cmd, spec.args, { cwd, env: buildLaunchEnv(spec), detached: true, stdio: 'ignore' })
  child.unref()
  const kill = (): void => { const p = child.pid; if (p) { try { process.kill(-p, 'SIGKILL') } catch { try { process.kill(p, 'SIGKILL') } catch { /* gone */ } } } }
  return child.pid !== undefined ? { pid: child.pid, kill } : { kill }
}

/** Real readiness probe: a 200-ish response from the loopback port. */
const defaultProbe: Probe = port => new Promise(res => {
  void import('node:http').then(({ get }) => {
    const req = get({ host: '127.0.0.1', port, path: '/', timeout: 1000 }, r => { r.resume(); res((r.statusCode ?? 500) < 500) })
    req.on('error', () => res(false))
    req.on('timeout', () => { req.destroy(); res(false) })
  }).catch(() => res(false))
})

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
  constructor(private deps: PreviewRegistryDeps) {
    this.launch = deps.launch ?? defaultLaunch
    this.probe = deps.probe ?? defaultProbe
  }

  get(sessionId: string): PreviewEntry | undefined { return this.entries.get(sessionId) }

  private set(e: PreviewEntry): PreviewEntry { this.entries.set(e.sessionId, e); this.deps.onStatus?.(e); return e }

  async start(sessionId: string, dir: string, type: AppType): Promise<PreviewEntry> {
    await this.stop(sessionId) // replace any prior preview for this session
    const spec = startSpec(type, 0)
    if (!spec) { await teardown(dir).catch(() => {}); return this.set({ sessionId, status: 'unsupported', dir, reason: `app type '${type}' not previewable` }) }

    this.set({ sessionId, status: 'starting', dir })
    const install = installSpec()
    const res = await this.deps.sandbox.run(install.cmd, install.args, { cwd: dir, timeoutMs: this.deps.installTimeoutMs ?? 120_000 })
    if (res.code !== 0) { await teardown(dir).catch(() => {}); return this.set({ sessionId, status: 'failed', dir, reason: `install failed (code ${res.code})` }) }

    const port = await allocatePort()
    const proc = this.launch(startSpec(type, port)!, dir)
    this.procs.set(sessionId, proc)

    const attempts = this.deps.probeAttempts ?? 20
    const interval = this.deps.probeIntervalMs ?? 250
    for (let i = 0; i < attempts; i++) {
      if (await this.probe(port)) {
        return this.set({ sessionId, status: 'ready', dir, port, url: `/preview/${sessionId}/` })
      }
      await new Promise(r => setTimeout(r, interval))
    }
    proc.kill(); releasePort(port); this.procs.delete(sessionId)
    await teardown(dir).catch(() => {})
    return this.set({ sessionId, status: 'failed', dir, port, reason: 'readiness probe timed out' })
  }

  async stop(sessionId: string): Promise<void> {
    const proc = this.procs.get(sessionId)
    if (proc) { proc.kill(); this.procs.delete(sessionId) }
    const e = this.entries.get(sessionId)
    if (e?.port !== undefined) releasePort(e.port)
    if (e) { this.set({ ...e, status: 'stopped', ...(e.port !== undefined ? {} : {}) }); await teardown(e.dir).catch(() => {}) }
  }

  /** Port for a session's ready preview (for the proxy upstream). */
  portFor(sessionId: string): number | undefined {
    const e = this.entries.get(sessionId)
    return e?.status === 'ready' ? e.port : undefined
  }
}
