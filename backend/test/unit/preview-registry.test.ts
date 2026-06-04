import { describe, it, expect, vi } from 'vitest'
import { installSpec, startSpec } from '../../src/preview/Runner.js'
import { PreviewRegistry, buildLaunchEnv, type Launch, type Probe, type PreviewProc } from '../../src/preview/PreviewRegistry.js'
import type { Sandbox, RunResult } from '../../src/exec/Sandbox.js'

const okSandbox: Sandbox = { async run(): Promise<RunResult> { return { code: 0, stdout: '', stderr: '', timedOut: false } } }
const failSandbox: Sandbox = { async run(): Promise<RunResult> { return { code: 1, stdout: '', stderr: 'boom', timedOut: false } } }

function fakeProc(): PreviewProc & { killed: boolean } {
  const p = { pid: 4242, killed: false, kill() { p.killed = true } }
  return p
}

/** A fake proc that can simulate an early exit + a stderr tail (diagnostics). */
function exitingProc(code: number | null, stderr = ''): PreviewProc & { killed: boolean } {
  let cb: ((c: number | null) => void) | undefined
  const p = {
    pid: 4243, killed: false,
    kill() { p.killed = true },
    stderrTail: () => stderr,
    onExit(fn: (c: number | null) => void) { cb = fn; setTimeout(() => cb?.(code), 1) },
  }
  return p
}

describe('Runner specs', () => {
  it('install blocks lifecycle scripts', () => {
    expect(installSpec().args).toContain('--ignore-scripts')
  })
  it('vite start binds the port on loopback with strictPort', () => {
    const s = startSpec('vite', 5190)!
    expect(s.cmd).toBe('pnpm')
    expect(s.args.join(' ')).toContain('vite --port 5190 --strictPort --host 127.0.0.1')
  })
  it('vite start threads the same-origin --base so assets resolve under /preview/:id/', () => {
    const s = startSpec('vite', 5190, 'sess-abc')!
    expect(s.args.join(' ')).toContain('--base /preview/sess-abc/')
  })
  it('next start runs `next dev` on the loopback port', () => {
    const s = startSpec('next', 7100, 'sess-x')!
    expect(s.cmd).toBe('pnpm')
    expect(s.args.join(' ')).toContain('next dev --port 7100 --hostname 127.0.0.1')
    expect(s.env.NEXT_PUBLIC_BASE_PATH).toBe('/preview/sess-x')
  })
  it('node-service passes PORT via env', () => {
    expect(startSpec('node-service', 7000)!.env.PORT).toBe('7000')
  })
  it('static/unsupported have no start spec (deferred)', () => {
    expect(startSpec('static', 1)).toBeNull()
    expect(startSpec('unsupported', 1)).toBeNull()
  })
})

describe('buildLaunchEnv', () => {
  it('scrubs AI keys/key-store from the preview child env, keeps spec env (no re-leak)', () => {
    process.env.ANTHROPIC_API_KEY = 'leak-me'
    process.env.AI_KEY_STORE_PATH = '/secret'
    try {
      const env = buildLaunchEnv({ cmd: 'node', args: [], env: { PORT: '5000' } })
      expect(env.ANTHROPIC_API_KEY).toBeUndefined()
      expect(env.AI_KEY_STORE_PATH).toBeUndefined()
      expect(env.PORT).toBe('5000')
    } finally {
      delete process.env.ANTHROPIC_API_KEY
      delete process.env.AI_KEY_STORE_PATH
    }
  })
})

describe('PreviewRegistry lifecycle', () => {
  it('starts → ready with a same-origin url; stop kills the proc', async () => {
    const proc = fakeProc()
    const launch: Launch = () => proc
    const probe: Probe = async () => true
    const reg = new PreviewRegistry({ sandbox: okSandbox, commandOnPath: async () => true, launch, probe })
    const e = await reg.start('s1', '/ws/s1', 'vite')
    expect(e.status).toBe('ready')
    expect(e.url).toBe('/preview/s1/')
    expect(reg.portFor('s1')).toBe(e.port)
    await reg.stop('s1')
    expect(proc.killed).toBe(true)
    expect(reg.get('s1')?.status).toBe('stopped')
  })

  it('fails (and does not launch) when install fails', async () => {
    const launch = vi.fn<Launch>(() => fakeProc())
    const reg = new PreviewRegistry({ sandbox: failSandbox, commandOnPath: async () => true, launch, probe: async () => true })
    const e = await reg.start('s1', '/ws/s1', 'vite')
    expect(e.status).toBe('failed')
    expect(e.reason).toMatch(/install failed/)
    expect(launch).not.toHaveBeenCalled()
  })

  it('fails and kills the proc when readiness never comes', async () => {
    const proc = fakeProc()
    const reg = new PreviewRegistry({ sandbox: okSandbox, commandOnPath: async () => true, launch: () => proc, probe: async () => false, probeAttempts: 2, probeIntervalMs: 1 })
    const e = await reg.start('s1', '/ws/s1', 'vite')
    expect(e.status).toBe('failed')
    expect(e.reason).toMatch(/readiness probe/)
    expect(proc.killed).toBe(true)
  })

  it('marks unsupported app types without installing', async () => {
    const run = vi.fn(okSandbox.run)
    const reg = new PreviewRegistry({ sandbox: { run }, launch: () => fakeProc(), probe: async () => true })
    const e = await reg.start('s1', '/ws/s1', 'unsupported')
    expect(e.status).toBe('unsupported')
    expect(run).not.toHaveBeenCalled()
  })

  it('serves static apps instantly: ready with NO install, NO launch, served from dir', async () => {
    const run = vi.fn(okSandbox.run)
    const launch = vi.fn<Launch>(() => fakeProc())
    const reg = new PreviewRegistry({ sandbox: { run }, launch, probe: async () => true })
    const e = await reg.start('s1', '/ws/s1', 'static')
    expect(e.status).toBe('ready')
    expect(e.type).toBe('static')
    expect(e.url).toBe('/preview/s1/')
    expect(e.port).toBeUndefined()
    expect(run).not.toHaveBeenCalled()        // no pnpm install
    expect(launch).not.toHaveBeenCalled()      // no process spawned
    expect(reg.portFor('s1')).toBeUndefined()  // proxy must not treat it as a port
    expect(reg.staticDirFor('s1')).toBe('/ws/s1')
  })

  it('emits status transitions via onStatus', async () => {
    const seen: string[] = []
    const reg = new PreviewRegistry({ sandbox: okSandbox, commandOnPath: async () => true, launch: () => fakeProc(), probe: async () => true, onStatus: e => seen.push(e.status) })
    await reg.start('s1', '/ws/s1', 'vite')
    expect(seen).toContain('starting')
    expect(seen).toContain('ready')
  })
})

describe('PreviewRegistry.stopAll (graceful shutdown)', () => {
  it('kills every tracked proc, releases ports, and marks each stopped (tolerating errors)', async () => {
    const procs = [fakeProc(), fakeProc()]
    let i = 0
    const reg = new PreviewRegistry({ sandbox: okSandbox, commandOnPath: async () => true, launch: () => procs[i++]!, probe: async () => true })
    const a = await reg.start('a', '/ws/a', 'vite')
    const b = await reg.start('b', '/ws/b', 'vite')
    expect(a.status).toBe('ready'); expect(b.status).toBe('ready')

    await reg.stopAll()
    expect(procs[0]!.killed).toBe(true)
    expect(procs[1]!.killed).toBe(true)
    expect(reg.get('a')?.status).toBe('stopped')
    expect(reg.get('b')?.status).toBe('stopped')
    // Ports released → no longer a live upstream for the proxy.
    expect(reg.portFor('a')).toBeUndefined()
    expect(reg.portFor('b')).toBeUndefined()
  })

  it('tolerates a proc whose kill throws (one bad entry cannot block the rest)', async () => {
    const bad = { pid: 1, killed: false, kill() { throw new Error('kill boom') } } as PreviewProc & { killed: boolean }
    const good = fakeProc()
    let i = 0
    const reg = new PreviewRegistry({ sandbox: okSandbox, commandOnPath: async () => true, launch: () => [bad, good][i++]!, probe: async () => true })
    await reg.start('bad', '/ws/bad', 'vite')
    await reg.start('good', '/ws/good', 'vite')
    await expect(reg.stopAll()).resolves.toBeUndefined()
    expect(good.killed).toBe(true)
  })
})

describe('PreviewRegistry diagnostics (D)', () => {
  it('fails FAST with the exit code + stderr tail when the child exits early (not the whole probe budget)', async () => {
    const reg = new PreviewRegistry({
      sandbox: okSandbox,
      commandOnPath: async () => true,
      launch: () => exitingProc(137, 'Error: Cannot find module react\n    at ...'),
      probe: async () => false, // never ready — must surface the early exit, not "timed out"
      probeAttempts: 50, probeIntervalMs: 5,
    })
    const e = await reg.start('s1', '/ws/s1', 'vite')
    expect(e.status).toBe('failed')
    expect(e.reason).toMatch(/exited early \(code 137\)/)
    expect(e.reason).toMatch(/Cannot find module react/)
  })

  it('attaches the install stderr tail to an install-failed reason', async () => {
    const sb: Sandbox = { async run(): Promise<RunResult> { return { code: 1, stdout: '', stderr: 'ERR_PNPM_NO_MATCHING_VERSION foo@99', timedOut: false } } }
    const reg = new PreviewRegistry({ sandbox: sb, commandOnPath: async () => true, launch: () => fakeProc(), probe: async () => true })
    const e = await reg.start('s1', '/ws/s1', 'vite')
    expect(e.status).toBe('failed')
    expect(e.reason).toMatch(/install failed \(code 1\)/)
    expect(e.reason).toMatch(/ERR_PNPM_NO_MATCHING_VERSION/)
  })
})

// PR #83 review: the install preflight is an INJECTABLE seam (commandOnPath), so the lifecycle
// stays unit-testable without a real pnpm on the host PATH — and both branches are covered.
describe('PreviewRegistry install preflight (injectable commandOnPath)', () => {
  it('fails with an actionable "enable corepack" hint and does NOT install when the command is missing', async () => {
    const run = vi.fn(okSandbox.run)
    const launch = vi.fn<Launch>(() => fakeProc())
    const reg = new PreviewRegistry({ sandbox: { run }, commandOnPath: async () => false, launch, probe: async () => true })
    const e = await reg.start('s1', '/ws/s1', 'vite')
    expect(e.status).toBe('failed')
    expect(e.reason).toMatch(/not found — enable corepack/)
    expect(run).not.toHaveBeenCalled()    // preflight short-circuits BEFORE the install
    expect(launch).not.toHaveBeenCalled()
  })
  it('proceeds to install + ready when the command IS present', async () => {
    const run = vi.fn(okSandbox.run)
    const reg = new PreviewRegistry({ sandbox: { run }, commandOnPath: async () => true, launch: () => fakeProc(), probe: async () => true })
    const e = await reg.start('s1', '/ws/s1', 'vite')
    expect(e.status).toBe('ready')
    expect(run).toHaveBeenCalledTimes(1)
  })
})

describe('PreviewRegistry — post-ready crash watch (live-caught stale-ready 502s)', () => {
  /** A proc that supports MULTIPLE onExit listeners (like the real launcher) and can be
   *  crashed ON DEMAND after the registry reports ready. */
  function crashableProc(stderr = 'TypeError: boom') {
    const cbs: ((c: number | null) => void)[] = []
    const p = {
      pid: 4244, killed: false,
      kill() { p.killed = true },
      stderrTail: () => stderr,
      onExit(fn: (c: number | null) => void) { cbs.push(fn) },
      crash(code: number) { for (const cb of cbs) cb(code) },
    }
    return p
  }

  it('a crash AFTER ready flips the entry to failed with the exit code + stderr tail (no more silent 502s)', async () => {
    const proc = crashableProc('Error [ERR_HTTP_HEADERS_SENT]: Cannot write headers after they are sent')
    const statuses: string[] = []
    const reg = new PreviewRegistry({
      sandbox: okSandbox,
      launch: (() => proc) as Launch,
      probe: (async () => true) as Probe,
      commandOnPath: async () => true,
      probeAttempts: 2, probeIntervalMs: 1,
      onStatus: e => statuses.push(e.status),
    })
    const entry = await reg.start('s-crash', '/tmp/akis-test-crash', 'node-service')
    expect(entry.status).toBe('ready')
    proc.crash(1)
    await new Promise(r => setTimeout(r, 10))
    const after = reg.get('s-crash')!
    expect(after.status).toBe('failed')
    expect(after.reason).toMatch(/crashed after start \(code 1\)/)
    expect(after.reason).toMatch(/ERR_HTTP_HEADERS_SENT/)
    expect(statuses).toContain('failed')
    // The dead port is no longer advertised to the proxy.
    expect(reg.portFor('s-crash')).toBeUndefined()
  })

  it('a stop() BEFORE the exit fires is not overwritten (stale-guard)', async () => {
    const proc = crashableProc()
    const reg = new PreviewRegistry({
      sandbox: okSandbox,
      launch: (() => proc) as Launch,
      probe: (async () => true) as Probe,
      commandOnPath: async () => true,
      probeAttempts: 2, probeIntervalMs: 1,
    })
    await reg.start('s-stop', '/tmp/akis-test-stop', 'node-service')
    await reg.stop('s-stop')
    proc.crash(137) // SIGKILL from stop() surfaces as an exit — must NOT flip stopped → failed
    await new Promise(r => setTimeout(r, 10))
    expect(reg.get('s-stop')!.status).toBe('stopped')
  })
})
