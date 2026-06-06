import { describe, it, expect } from 'vitest'
import { closeMcpPoolBestEffort } from '../../src/api/server.js'

/**
 * Graceful-shutdown teardown of the GitHub-MCP transport pool (findings #3/#5/#9): the documented
 * contract is "the graceful-shutdown path closeAll()s it so per-session Docker children are torn
 * down." Previously closeAll() was NEVER invoked in the shutdown path, so a transport in its idle
 * window or in-flight at SIGTERM orphaned a token-bearing `docker run` container past process exit.
 *
 * closeMcpPoolBestEffort is the wired teardown the shutdown close() now calls (alongside
 * previewRegistry.stopAll(), before the pool closes). These tests pin: (1) it actually invokes
 * closeAll(); (2) absent a pool (MCP not wired) it is a safe no-op; (3) a HANGING transport close
 * cannot eat the shutdown grace — the bounded race resolves on a timeout the test fires manually,
 * so a wedged closeAll never blocks the caller. NO real Docker, NO real timers (HARD CONSTRAINT 4).
 */

/** A controllable fake timer matching the helper's injected `setTimer` shape — captured so a test
 *  fires the timeout deterministically (the bounded-race escape hatch) without real wall-clock. */
function fakeTimer(): {
  setTimer: (cb: () => void, ms: number) => { unref?: () => void }
  fire: () => void
  armedMs: number | undefined
} {
  let pending: (() => void) | undefined
  let armedMs: number | undefined
  return {
    setTimer: (cb, ms) => {
      pending = cb
      armedMs = ms
      return { unref: () => {} }
    },
    fire: () => pending?.(),
    get armedMs() { return armedMs },
  }
}

describe('closeMcpPoolBestEffort — graceful-shutdown closeAll() wiring', () => {
  it('invokes pool.closeAll() exactly once (the documented teardown contract)', async () => {
    let calls = 0
    const pool = { async closeAll(): Promise<void> { calls++ } }
    await closeMcpPoolBestEffort(pool, { setTimer: fakeTimer().setTimer })
    expect(calls).toBe(1)
  })

  it('absent a pool (MCP not wired) is a safe no-op', async () => {
    await expect(closeMcpPoolBestEffort(undefined)).resolves.toBeUndefined()
  })

  it('swallows a closeAll() rejection (best-effort — never throws into the shutdown drain)', async () => {
    const pool = { async closeAll(): Promise<void> { throw new Error('docker kill failed') } }
    await expect(closeMcpPoolBestEffort(pool, { setTimer: fakeTimer().setTimer })).resolves.toBeUndefined()
  })

  it('a HANGING transport close cannot block the shutdown — the bounded race resolves on timeout', async () => {
    // closeAll() never settles (a wedged client.close()); the helper must still resolve via the
    // injected timeout, so a single hung transport can never consume the whole shutdown grace.
    const clock = fakeTimer()
    const pool = { closeAll: () => new Promise<void>(() => {}) } // never resolves
    const p = closeMcpPoolBestEffort(pool, { timeoutMs: 5_000, setTimer: clock.setTimer })
    expect(clock.armedMs).toBe(5_000) // armed for exactly the configured grace
    clock.fire() // the bounded timeout elapses
    await expect(p).resolves.toBeUndefined() // resolved despite closeAll never settling
  })
})
