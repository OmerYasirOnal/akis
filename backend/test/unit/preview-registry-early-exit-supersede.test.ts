import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Launch, Probe, PreviewProc } from '../../src/preview/PreviewRegistry.js'
import type { Sandbox, RunResult } from '../../src/exec/Sandbox.js'

// audit P0-2 (review follow-up): the EARLY-EXIT branch is the one async-phase write whose clobber
// window (the `await teardown(dir)` inside it) cannot be reached by the dominant interleaving the
// other supersede tests exercise (those land on the loop-TOP owns-check). This test forces a stop()
// to land DETERMINISTICALLY *inside* that teardown await by mocking Workspace.teardown so its first
// call fires the stop — proving the post-teardown owns re-check stands the launch down instead of
// clobbering the honest 'stopped' entry back to 'failed'.
//
// The mock is scoped to THIS file (preview-registry's other tests use the real teardown).
const okSandbox: Sandbox = { async run(): Promise<RunResult> { return { code: 0, stdout: '', stderr: '', timedOut: false } } }

/** A proc whose early exit we fire ON DEMAND (not on a timer), so the loop reaches the early-exit
 *  branch only when we choose. */
function manualExitProc(): PreviewProc & { killed: boolean; fireExit: (code: number) => void } {
  let cb: ((c: number | null) => void) | undefined
  const p = {
    pid: 9001, killed: false,
    kill() { p.killed = true },
    stderrTail: () => 'manual early death',
    onExit(fn: (c: number | null) => void) { cb = fn },
    fireExit(code: number) { cb?.(code) },
  }
  return p
}

describe('PreviewRegistry early-exit branch ownership re-check (audit P0-2 follow-up)', () => {
  beforeEach(() => { vi.resetModules() })

  it('a stop() landing INSIDE the early-exit teardown await is NOT clobbered back to failed', async () => {
    // First teardown() call (the early-exit branch's) fires the stop() before resolving — so the
    // stop lands precisely in the clobber window. Later teardown() calls (stop's own, etc.) no-op.
    let stopOnFirstTeardown: (() => void) | undefined
    const teardown = vi.fn(async (_dir: string) => {
      if (stopOnFirstTeardown) { const fn = stopOnFirstTeardown; stopOnFirstTeardown = undefined; fn() }
    })
    vi.doMock('../../src/preview/Workspace.js', () => ({
      teardown,
      materialize: async (_id: string, _files: unknown) => '/ws/mock',
      workspacesRoot: () => '/ws',
      reclaimWorkspaces: async () => {},
    }))
    const { PreviewRegistry } = await import('../../src/preview/PreviewRegistry.js')

    const proc = manualExitProc()
    const launch: Launch = () => proc
    const probe: Probe = async () => false // never ready → the early-exit drives the outcome
    const reg = new PreviewRegistry({ sandbox: okSandbox, commandOnPath: async () => true, launch, probe, probeAttempts: 200, probeIntervalMs: 1 })

    // Arm: when the early-exit branch calls teardown(), it will fire reg.stop('s1') — landing the
    // stop INSIDE the await, with the launch's token still current at the branch entry.
    stopOnFirstTeardown = () => { void reg.stop('s1') }

    const startP = reg.start('s1', '/ws/s1', 'vite')
    // Let the launch get into its probe loop, then fire the early exit so the next iteration enters
    // the early-exit branch (owns still true) → its teardown() fires the stop.
    await new Promise(r => setTimeout(r, 5))
    proc.fireExit(1)

    await startP
    // The stop() must WIN: the entry stays 'stopped' (honest), NOT clobbered to 'failed'.
    expect(reg.get('s1')?.status).toBe('stopped')
    expect(reg.get('s1')?.reason).toBeUndefined() // not the "exited early" failure reason
  })
})
