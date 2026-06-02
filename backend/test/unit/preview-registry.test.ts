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

describe('Runner specs', () => {
  it('install blocks lifecycle scripts', () => {
    expect(installSpec().args).toContain('--ignore-scripts')
  })
  it('vite start binds the port on loopback with strictPort', () => {
    const s = startSpec('vite', 5190)!
    expect(s.cmd).toBe('pnpm')
    expect(s.args.join(' ')).toContain('vite --port 5190 --strictPort --host 127.0.0.1')
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
    const reg = new PreviewRegistry({ sandbox: okSandbox, launch, probe })
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
    const reg = new PreviewRegistry({ sandbox: failSandbox, launch, probe: async () => true })
    const e = await reg.start('s1', '/ws/s1', 'vite')
    expect(e.status).toBe('failed')
    expect(e.reason).toMatch(/install failed/)
    expect(launch).not.toHaveBeenCalled()
  })

  it('fails and kills the proc when readiness never comes', async () => {
    const proc = fakeProc()
    const reg = new PreviewRegistry({ sandbox: okSandbox, launch: () => proc, probe: async () => false, probeAttempts: 2, probeIntervalMs: 1 })
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
    const reg = new PreviewRegistry({ sandbox: okSandbox, launch: () => fakeProc(), probe: async () => true, onStatus: e => seen.push(e.status) })
    await reg.start('s1', '/ws/s1', 'vite')
    expect(seen).toContain('starting')
    expect(seen).toContain('ready')
  })
})
