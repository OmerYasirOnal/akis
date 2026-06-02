import { describe, it, expect, vi } from 'vitest'
import { installGracefulShutdown } from '../../src/api/shutdown.js'

/**
 * Graceful shutdown: on SIGTERM/SIGINT (e.g. `docker stop`) the process must stop
 * accepting connections, drain in-flight work and close the DB pool BEFORE exiting,
 * with a hard timeout backstop so a hung drain can never wedge the container. The
 * helper is fully injectable (process surface, timers) so it is deterministic offline.
 */

interface FakeProc {
  on(event: string, fn: (...a: unknown[]) => unknown): FakeProc
  exit(code?: number): never
  /** Invoke a registered signal handler (throws if none) and return its result. */
  fire(event: string): unknown
  registered: string[]
  exits: number[]
}

function fakeProc(): FakeProc {
  const listeners = new Map<string, (...a: unknown[]) => unknown>()
  const exits: number[] = []
  const proc: FakeProc = {
    on(event, fn) { listeners.set(event, fn); return proc },
    exit(code = 0) { exits.push(code); return undefined as never },
    fire(event) {
      const fn = listeners.get(event)
      if (!fn) throw new Error(`no handler registered for ${event}`)
      return fn(event)
    },
    get registered() { return [...listeners.keys()] },
    exits,
  }
  return proc
}

function fakeTimers() {
  let cb: (() => void) | undefined
  let cleared = false
  return {
    setTimeout: ((fn: () => void) => { cb = fn; return 1 as unknown as NodeJS.Timeout }) as unknown as typeof setTimeout,
    clearTimeout: ((_t: unknown) => { cleared = true }) as unknown as typeof clearTimeout,
    fire() { cb?.() },
    get cleared() { return cleared },
  }
}

describe('installGracefulShutdown', () => {
  it('registers handlers for SIGTERM and SIGINT by default', () => {
    const proc = fakeProc()
    installGracefulShutdown({ close: async () => {}, proc, log: () => {}, timers: fakeTimers() })
    expect([...proc.registered].sort()).toEqual(['SIGINT', 'SIGTERM'])
  })

  it('drains via close() then exits 0 and clears the timeout', async () => {
    const proc = fakeProc()
    const timers = fakeTimers()
    const close = vi.fn(async () => {})
    installGracefulShutdown({ close, proc, log: () => {}, timers })

    await proc.fire('SIGTERM')

    expect(close).toHaveBeenCalledTimes(1)
    expect(proc.exits).toEqual([0])
    expect(timers.cleared).toBe(true)
  })

  it('ignores a second signal while a drain is already in progress', () => {
    const proc = fakeProc()
    const close = vi.fn(() => new Promise<void>(() => {})) // never resolves
    installGracefulShutdown({ close, proc, log: () => {}, timers: fakeTimers() })

    void proc.fire('SIGTERM') // starts the (pending) drain
    void proc.fire('SIGINT')  // arrives mid-drain — must be ignored

    expect(close).toHaveBeenCalledTimes(1)
    expect(proc.exits).toEqual([]) // still draining; not exited yet
  })

  it('force-exits 1 if the drain hangs past the timeout', () => {
    const proc = fakeProc()
    const timers = fakeTimers()
    installGracefulShutdown({
      close: () => new Promise<void>(() => {}), // hangs forever
      proc, log: () => {}, timers, timeoutMs: 5000,
    })

    void proc.fire('SIGTERM')
    timers.fire() // simulate the timeout firing

    expect(proc.exits).toEqual([1])
  })

  it('exits 1 if close() rejects (drain error) and does not also exit 0', async () => {
    const proc = fakeProc()
    const timers = fakeTimers()
    installGracefulShutdown({
      close: async () => { throw new Error('pool already ended') },
      proc, log: () => {}, timers,
    })

    await proc.fire('SIGTERM')

    expect(proc.exits).toEqual([1])
    expect(timers.cleared).toBe(true)
  })
})
