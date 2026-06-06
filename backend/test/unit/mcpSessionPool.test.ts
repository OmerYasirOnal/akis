import { describe, it, expect } from 'vitest'
import { McpSessionPool, type McpTransportFactory } from '../../src/agent/mcp/McpSessionPool.js'
import type { McpTransport, McpToolInfo, McpToolResult } from '../../src/agent/mcp/McpTransport.js'

/**
 * McpSessionPool is the SP1 PROCESS-REUSE OPTIMIZATION: ONE initialized transport per
 * (ownerId, token) scope key reused across a session's tool calls, with refcount-gated
 * idle teardown. These tests pin that contract with FAKE transports only — NO Docker, NO
 * network (HARD CONSTRAINT #4). The pool's only host couplings (the factory and the idle
 * timer) are injected, so every case below is fully deterministic offline:
 *  - the factory is a hand-rolled counter (explicit fakes over a mock library, per the
 *    neighboring shutdown.test.ts / githubConnectionStore.test.ts idiom);
 *  - idle teardown uses a CONTROLLABLE fake timer (manual `fire()`) — that injectable
 *    `setTimer` seam IS the pool's fake-timer surface; we never touch real wall-clock time.
 */

/** A FAKE McpTransport — records its own lifecycle (init/close counts) so a test can assert
 *  "initialize ran ONCE" or "close ran exactly once". `close()` is overridable so a single
 *  case can make a DEAD transport whose close rejects. */
interface FakeTransport extends McpTransport {
  readonly id: number
  initCount: number
  closeCount: number
}

function makeFake(id: number, opts: { closeRejects?: boolean } = {}): FakeTransport {
  const t: FakeTransport = {
    id,
    initCount: 0,
    closeCount: 0,
    async initialize(): Promise<void> {
      t.initCount++
    },
    async listTools(): Promise<McpToolInfo[]> {
      return []
    },
    async callTool(): Promise<McpToolResult> {
      return { text: '', isError: false }
    },
    async close(): Promise<void> {
      t.closeCount++
      if (opts.closeRejects) throw new Error('docker kill failed') // a "dead"/hung transport
    },
  }
  return t
}

/** A controllable fake timer matching the pool's injected `setTimer` shape. Each armed timer
 *  is captured so a test fires it on demand — no real timers, no flakiness. We track cancels
 *  so "re-acquire cancels the armed teardown" is observable. */
function fakeClock() {
  interface Armed {
    cb: () => void
    ms: number
    fired: boolean
    cancelled: boolean
  }
  const armed: Armed[] = []
  const setTimer = (cb: () => void, ms: number): { cancel: () => void } => {
    const a: Armed = { cb, ms, fired: false, cancelled: false }
    armed.push(a)
    return {
      cancel(): void {
        a.cancelled = true
      },
    }
  }
  return {
    setTimer,
    armed,
    /** Fire EVERY still-armed (not cancelled, not yet fired) timer — the idle window elapses. */
    tick(): void {
      for (const a of armed) {
        if (!a.cancelled && !a.fired) {
          a.fired = true
          a.cb()
        }
      }
    },
  }
}

/** A factory wrapper that hands out a fresh FakeTransport per call and records the
 *  (ownerId, token) material it saw — so we can assert the factory is called once per key
 *  and never receives the hashed key (it gets ownerId+token, never the digest). */
function countingFactory(opts: { closeRejects?: boolean } = {}): {
  factory: McpTransportFactory
  built: FakeTransport[]
  calls: Array<{ ownerId: string; token: string }>
} {
  const built: FakeTransport[] = []
  const calls: Array<{ ownerId: string; token: string }> = []
  const factory: McpTransportFactory = ({ ownerId, token }) => {
    calls.push({ ownerId, token })
    const t = makeFake(built.length, opts)
    built.push(t)
    return t
  }
  return { factory, built, calls }
}

const OWNER = 'user-1'
const TOKEN = 'ghp_secret_aaaa'

describe('McpSessionPool', () => {
  it('reuses the SAME live transport for the same (owner, token) — no respawn', async () => {
    const { factory, built } = countingFactory()
    const pool = new McpSessionPool({ factory })

    const a = await pool.acquire(OWNER, TOKEN)
    const b = await pool.acquire(OWNER, TOKEN)

    expect(a).toBe(b) // same instance handed back
    expect(built).toHaveLength(1) // factory ran ONCE — the child was not respawned
    expect((a as FakeTransport).initCount).toBe(1) // initialize() ran ONCE per key, not per acquire
  })

  it('gives DIFFERENT transports for different tokens (same owner)', async () => {
    const { factory, built } = countingFactory()
    const pool = new McpSessionPool({ factory })

    const a = await pool.acquire(OWNER, 'ghp_token_one')
    const b = await pool.acquire(OWNER, 'ghp_token_two')

    expect(a).not.toBe(b)
    expect(built).toHaveLength(2) // a distinct key per token ⇒ a distinct transport
  })

  it('gives DIFFERENT transports for different owners that share a token (scope is owner+token)', async () => {
    const { factory, built, calls } = countingFactory()
    const pool = new McpSessionPool({ factory })

    // SCOPE-SAFETY: two distinct owners that happen to share a PAT must NOT share a transport.
    const a = await pool.acquire('owner-A', TOKEN)
    const b = await pool.acquire('owner-B', TOKEN)

    expect(a).not.toBe(b)
    expect(built).toHaveLength(2)
    // The factory sees the raw owner+token material (never the digest) — both keyed off the
    // same token but a different ownerId.
    expect(calls).toEqual([
      { ownerId: 'owner-A', token: TOKEN },
      { ownerId: 'owner-B', token: TOKEN },
    ])
  })

  it('does NOT arm the idle timer while the transport is still referenced', async () => {
    const clock = fakeClock()
    const { factory } = countingFactory()
    const pool = new McpSessionPool({ factory, idleMs: 1000, setTimer: clock.setTimer })

    await pool.acquire(OWNER, TOKEN) // refcount 1
    await pool.acquire(OWNER, TOKEN) // refcount 2
    pool.release(OWNER, TOKEN) // refcount back to 1 — STILL in use

    expect(clock.armed).toHaveLength(0) // no teardown armed: an in-flight call keeps it alive
  })

  it('tears the transport down after the idle TTL once the last reference is released', async () => {
    const clock = fakeClock()
    const { factory, built } = countingFactory()
    const pool = new McpSessionPool({ factory, idleMs: 60_000, setTimer: clock.setTimer })

    const t = (await pool.acquire(OWNER, TOKEN)) as FakeTransport
    pool.release(OWNER, TOKEN) // refcount → 0: arms the idle timer

    expect(clock.armed).toHaveLength(1)
    expect(clock.armed[0]?.ms).toBe(60_000) // armed for exactly the configured grace window
    expect(t.closeCount).toBe(0) // not yet — the grace window has not elapsed

    clock.tick() // the idle window elapses
    await Promise.resolve() // let the swallowed close() promise settle

    expect(t.closeCount).toBe(1) // closed exactly once after the TTL

    // After teardown the key is gone — a later acquire builds a FRESH transport (clean retry).
    const t2 = (await pool.acquire(OWNER, TOKEN)) as FakeTransport
    expect(t2).not.toBe(t)
    expect(built).toHaveLength(2)
  })

  it('a re-acquire within the idle window CANCELS the armed teardown (transport survives)', async () => {
    const clock = fakeClock()
    const { factory, built } = countingFactory()
    const pool = new McpSessionPool({ factory, idleMs: 1000, setTimer: clock.setTimer })

    const t = (await pool.acquire(OWNER, TOKEN)) as FakeTransport
    pool.release(OWNER, TOKEN) // arms teardown
    expect(clock.armed).toHaveLength(1)

    await pool.acquire(OWNER, TOKEN) // re-acquired in the window — must cancel the armed timer
    expect(clock.armed[0]?.cancelled).toBe(true)

    clock.tick() // even if the (cancelled) timer's slot is swept, the guard must hold
    await Promise.resolve()

    expect(t.closeCount).toBe(0) // survived: never torn down
    expect(built).toHaveLength(1) // same transport reused — no respawn
  })

  it('idle teardown of a DEAD transport (close rejects) is swallowed — no unhandled rejection', async () => {
    const clock = fakeClock()
    const { factory, built } = countingFactory({ closeRejects: true })
    const pool = new McpSessionPool({ factory, idleMs: 500, setTimer: clock.setTimer })

    const t = (await pool.acquire(OWNER, TOKEN)) as FakeTransport
    pool.release(OWNER, TOKEN)

    clock.tick() // fires teardown → close() rejects ("docker kill failed")
    await Promise.resolve()
    await Promise.resolve() // drain the rejected promise's microtask: best-effort .catch swallows it

    expect(t.closeCount).toBe(1) // close WAS attempted...
    // ...and the key was still removed despite the reject — a fresh acquire rebuilds cleanly.
    const t2 = (await pool.acquire(OWNER, TOKEN)) as FakeTransport
    expect(t2).not.toBe(t)
    expect(built).toHaveLength(2)
  })

  it('concurrent acquires of the same key race to ONE transport (one spawn, one initialize)', async () => {
    // A factory whose transports BLOCK in initialize() until released — this widens the race
    // window so any double-spawn would be caught. The pool must still build exactly one.
    let releaseInit: () => void = () => {}
    const initGate = new Promise<void>(resolve => {
      releaseInit = resolve
    })
    const built: FakeTransport[] = []
    const factory: McpTransportFactory = () => {
      const base = makeFake(built.length)
      const t: FakeTransport = {
        ...base,
        async initialize(): Promise<void> {
          base.initCount++
          await initGate // hold the handshake open across the concurrent acquires
        },
        get initCount() {
          return base.initCount
        },
        get closeCount() {
          return base.closeCount
        },
      }
      built.push(t)
      return t
    }
    const pool = new McpSessionPool({ factory })

    // Fire two acquires for the SAME key without awaiting between them.
    const p1 = pool.acquire(OWNER, TOKEN)
    const p2 = pool.acquire(OWNER, TOKEN)
    releaseInit() // let the single shared initialize() resolve

    const [a, b] = await Promise.all([p1, p2])

    expect(built).toHaveLength(1) // exactly ONE transport spawned for the racing acquires
    expect(a).toBe(b) // both callers got the same instance
    expect(built[0]?.initCount).toBe(1) // the shared initialize() ran ONCE
  })

  it('a failed initialize does NOT poison the key — a later acquire retries with a fresh transport', async () => {
    let fail = true
    const built: FakeTransport[] = []
    const factory: McpTransportFactory = () => {
      const base = makeFake(built.length)
      const shouldFail = fail
      const t: FakeTransport = {
        ...base,
        async initialize(): Promise<void> {
          base.initCount++
          if (shouldFail) throw new Error('handshake failed')
        },
        get initCount() {
          return base.initCount
        },
        get closeCount() {
          return base.closeCount
        },
      }
      built.push(t)
      return t
    }
    const pool = new McpSessionPool({ factory })

    await expect(pool.acquire(OWNER, TOKEN)).rejects.toThrow('handshake failed')

    fail = false
    const t2 = await pool.acquire(OWNER, TOKEN) // the poisoned entry was dropped — clean retry
    expect(t2).toBe(built[1]) // a brand-new transport, not the failed one
    expect(built).toHaveLength(2)
  })

  it('closeAll() closes EVERY live transport and clears the pool', async () => {
    const clock = fakeClock()
    const { factory, built } = countingFactory()
    const pool = new McpSessionPool({ factory, idleMs: 1000, setTimer: clock.setTimer })

    const a = (await pool.acquire('owner-A', 'tok-A')) as FakeTransport
    const b = (await pool.acquire('owner-B', 'tok-B')) as FakeTransport
    const c = (await pool.acquire('owner-C', 'tok-C')) as FakeTransport
    expect(built).toHaveLength(3)

    await pool.closeAll()

    expect(a.closeCount).toBe(1)
    expect(b.closeCount).toBe(1)
    expect(c.closeCount).toBe(1)

    // Pool is empty afterwards: a re-acquire of any prior key builds a FRESH transport.
    const a2 = (await pool.acquire('owner-A', 'tok-A')) as FakeTransport
    expect(a2).not.toBe(a)
    expect(built).toHaveLength(4)
  })

  it('closeAll() cancels armed idle timers and tolerates a transport whose close rejects', async () => {
    const clock = fakeClock()
    const { factory } = countingFactory({ closeRejects: true })
    const pool = new McpSessionPool({ factory, idleMs: 1000, setTimer: clock.setTimer })

    const t = (await pool.acquire(OWNER, TOKEN)) as FakeTransport
    pool.release(OWNER, TOKEN) // arms an idle timer
    expect(clock.armed).toHaveLength(1)

    await expect(pool.closeAll()).resolves.toBeUndefined() // a rejecting close must NOT block

    expect(t.closeCount).toBe(1) // closed once during shutdown
    expect(clock.armed[0]?.cancelled).toBe(true) // the armed teardown was cancelled

    // The (already-fired) timer must be a no-op now: firing it must not double-close.
    clock.tick()
    await Promise.resolve()
    expect(t.closeCount).toBe(1)
  })

  it('finding #8: closeAll() tolerates a HANGING transport close — others close, the caller is never blocked', async () => {
    // The SDK client.close() flush has no per-call timeout, so transport.close() can HANG (never
    // settle). closeAll() must race each close against closeTimeoutMs so one hang cannot block the
    // parallel teardown of the rest, nor the caller — the doc's "cannot block the caller" promise.
    const clock = fakeClock()
    const built: FakeTransport[] = []
    // A factory that makes the FIRST transport's close() hang forever, the rest close normally.
    const factory: McpTransportFactory = () => {
      const t = makeFake(built.length)
      if (built.length === 0) t.close = async () => { t.closeCount++; await new Promise<void>(() => {}) } // hangs
      built.push(t)
      return t
    }
    const pool = new McpSessionPool({ factory, idleMs: 1000, closeTimeoutMs: 2000, setTimer: clock.setTimer })

    const hung = (await pool.acquire('owner-A', 'tok-A')) as FakeTransport
    const ok = (await pool.acquire('owner-B', 'tok-B')) as FakeTransport
    expect(built).toHaveLength(2)

    const p = pool.closeAll()
    // The healthy transport's close resolves on its own; the hung one is bounded by the per-transport
    // timeout. Firing the armed timers settles the race for the hung close so closeAll resolves.
    clock.tick()
    await expect(p).resolves.toBeUndefined() // NOT blocked by the hung transport
    expect(ok.closeCount).toBe(1) // the healthy transport closed
    expect(hung.closeCount).toBe(1) // close WAS attempted on the hung one (it just never settled)
  })

  it('closeAll() on an empty pool is a no-op (idempotent shutdown)', async () => {
    const { factory, built } = countingFactory()
    const pool = new McpSessionPool({ factory })
    await expect(pool.closeAll()).resolves.toBeUndefined()
    await expect(pool.closeAll()).resolves.toBeUndefined() // second call also fine
    expect(built).toHaveLength(0)
  })

  it('release of an unknown key is a no-op (no throw)', () => {
    const { factory } = countingFactory()
    const pool = new McpSessionPool({ factory, setTimer: fakeClock().setTimer })
    expect(() => pool.release(OWNER, TOKEN)).not.toThrow()
  })
})
