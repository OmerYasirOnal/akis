import { describe, it, expect, vi } from 'vitest'
import { installSpec, startSpec } from '../../src/preview/Runner.js'
import { PreviewRegistry, type Launch, type Probe, type PreviewProc } from '../../src/preview/PreviewRegistry.js'
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

  it('emits status transitions via onStatus', async () => {
    const seen: string[] = []
    const reg = new PreviewRegistry({ sandbox: okSandbox, launch: () => fakeProc(), probe: async () => true, onStatus: e => seen.push(e.status) })
    await reg.start('s1', '/ws/s1', 'vite')
    expect(seen).toContain('starting')
    expect(seen).toContain('ready')
  })
})
