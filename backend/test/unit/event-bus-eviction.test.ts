import { describe, it, expect } from 'vitest'
import { EventBus } from '../../src/events/bus.js'
import type { AkisEvent } from '@akis/shared'

/**
 * BOUNDED MEMORY via LRU CAP (replaces the earlier time-eviction, which was a HIGH lifecycle
 * regression: it deleted a finished build's buffer 60s after it ended, so reopening that build —
 * the common "go to History, come back" case — returned an empty /log and collapsed the rail).
 * The bus now keeps only the most-recent `maxSessions` session buffers; the seq high-water mark is
 * retained even for an evicted session so head() stays truthful and replaySince() reports dropped:true
 * (so the FE re-syncs from session state instead of trusting a silently-empty log).
 */
const base = { agent: 'orchestrator' as const, laneId: 'main', ts: 1 }
const ev = (sessionId: string): AkisEvent => ({ ...base, kind: 'text', sessionId, text: 'x' })
const doneEv = (sessionId: string): AkisEvent => ({ ...base, kind: 'done', sessionId, verified: true, provider: 'mock' })

describe('EventBus LRU cap (bounded memory, recent reopens always replay)', () => {
  it('a recently-finished build is NEVER evicted on a timer — its log replays in full afterwards', () => {
    const bus = new EventBus(200, 200)
    bus.emit(ev('s1')); bus.emit(doneEv('s1'))
    // No timer, no grace: the terminal build's buffer stays as long as it's within the LRU window.
    expect(bus.replaySince('s1', 0).events).toHaveLength(2)
    expect(bus.replaySince('s1', 0).dropped).toBe(false)
    expect(bus.head('s1')).toBe(2)
  })

  it('over the cap, the OLDEST session buffer is evicted (newest retained); LRU touch keeps active ones', () => {
    const bus = new EventBus(200, 3)
    bus.emit(ev('a')); bus.emit(ev('b')); bus.emit(ev('c'))
    bus.emit(ev('a')) // LRU touch: 'a' moves to most-recent, so 'b' is now oldest
    bus.emit(ev('d')) // exceeds cap(3) → evict oldest = 'b'
    expect(bus.recent('b')).toHaveLength(0)            // evicted
    expect(bus.recent('a').length).toBeGreaterThan(0)  // touched → retained
    expect(bus.recent('c').length).toBeGreaterThan(0)
    expect(bus.recent('d').length).toBeGreaterThan(0)
  })

  it('an EVICTED session reports dropped:true (not a silent empty log) — the seq head is retained', () => {
    const bus = new EventBus(200, 1)
    bus.emit(ev('old')); bus.emit(doneEv('old')) // head('old') = 2
    bus.emit(ev('new'))                          // evicts 'old' buffer (cap 1)
    expect(bus.recent('old')).toHaveLength(0)     // buffer gone
    expect(bus.head('old')).toBe(2)               // but the high-water mark is retained (truthful)
    expect(bus.replaySince('old', 0).dropped).toBe(true) // → FE re-syncs from session state, no silent loss
  })

  it('a session that emitted NOTHING is not "dropped" (head 0 distinguishes evicted from never-emitted)', () => {
    const bus = new EventBus(200, 200)
    expect(bus.replaySince('ghost', 0)).toEqual({ events: [], dropped: false })
  })
})
