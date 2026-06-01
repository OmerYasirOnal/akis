import { describe, it, expect } from 'vitest'
import { EventBus } from '../../src/events/bus.js'
import type { AkisEvent } from '@akis/shared'

function ev(sessionId: string, n: number): AkisEvent {
  return { kind: 'text', text: `m${n}`, agent: 'orchestrator', laneId: 'main', sessionId, ts: n }
}

describe('EventBus per-session seq (F2-AC12 resumable stream)', () => {
  it('assigns a monotonic per-session seq starting at 1', () => {
    const bus = new EventBus()
    bus.emit(ev('s1', 1))
    bus.emit(ev('s1', 2))
    expect(bus.head('s1')).toBe(2)
    const { events } = bus.replaySince('s1', 0)
    expect(events.map(e => e.seq)).toEqual([1, 2])
  })

  it('keeps seq isolated across sessions', () => {
    const bus = new EventBus()
    bus.emit(ev('s1', 1))
    bus.emit(ev('s2', 1))
    bus.emit(ev('s1', 2))
    expect(bus.head('s1')).toBe(2)
    expect(bus.head('s2')).toBe(1)
    expect(bus.replaySince('s2', 0).events.map(e => e.seq)).toEqual([1])
  })

  it('head() is 0 for an unknown session', () => {
    expect(new EventBus().head('nope')).toBe(0)
  })

  it('replaySince returns only events after the cursor (no loss/dup on resume)', () => {
    const bus = new EventBus()
    for (let i = 1; i <= 5; i++) bus.emit(ev('s1', i))
    const r = bus.replaySince('s1', 3)
    expect(r.dropped).toBe(false)
    expect(r.events.map(e => e.seq)).toEqual([4, 5])
  })

  it('replaySince(head) returns nothing (fully caught up)', () => {
    const bus = new EventBus()
    bus.emit(ev('s1', 1))
    bus.emit(ev('s1', 2))
    expect(bus.replaySince('s1', 2).events).toEqual([])
  })

  it('delivers (event, seq) to subscribers', () => {
    const bus = new EventBus()
    const seen: Array<{ kind: string; seq: number }> = []
    bus.subscribe('s1', (e, seq) => seen.push({ kind: e.kind, seq }))
    bus.emit(ev('s1', 1))
    bus.emit(ev('s1', 2))
    expect(seen).toEqual([{ kind: 'text', seq: 1 }, { kind: 'text', seq: 2 }])
  })

  it('existing one-arg subscribers still work (back-compat)', () => {
    const bus = new EventBus()
    const seen: AkisEvent[] = []
    bus.subscribe('s1', e => seen.push(e)) // ignores seq
    bus.emit(ev('s1', 1))
    expect(seen).toHaveLength(1)
  })

  it('recent() still returns plain AkisEvent[] (back-compat)', () => {
    const bus = new EventBus()
    bus.emit(ev('s1', 1))
    const r = bus.recent('s1')
    expect(r).toHaveLength(1)
    expect(r[0]?.kind).toBe('text')
  })

  it('isolates a throwing listener: a broken subscriber cannot wedge the bus', () => {
    const bus = new EventBus()
    const seen: number[] = []
    bus.subscribe('s1', () => { throw new Error('boom') }) // e.g. write to a dead SSE socket
    bus.subscribe('s1', (_e, seq) => seen.push(seq))
    // The throw must not propagate back into the producer (emit) ...
    expect(() => bus.emit(ev('s1', 1))).not.toThrow()
    // ... and must not stop the other listener for this event.
    expect(seen).toEqual([1])
    // The bus keeps working for subsequent events too.
    expect(() => bus.emit(ev('s1', 2))).not.toThrow()
    expect(seen).toEqual([1, 2])
  })

  it('signals dropped=true once the buffer overflows (eviction)', () => {
    const cap = 3
    const bus = new EventBus(cap)
    for (let i = 1; i <= 5; i++) bus.emit(ev('s1', i)) // seq 1..5, only last 3 (seq 3,4,5) kept
    // Oldest retained seq is 3. dropped <=> the next event the client needs
    // (afterSeq+1) was evicted (afterSeq+1 < oldestRetained).
    expect(bus.replaySince('s1', 1).dropped).toBe(true)  // needs seq 2 (evicted)
    expect(bus.replaySince('s1', 0).dropped).toBe(true)  // needs seq 1 (evicted)
    // Caught up to the retained boundary: needs seq 3, which IS retained -> contiguous.
    const ok = bus.replaySince('s1', 2)
    expect(ok.dropped).toBe(false)
    expect(ok.events.map(e => e.seq)).toEqual([3, 4, 5])
    const fresh = bus.replaySince('s1', 4)
    expect(fresh.dropped).toBe(false)
    expect(fresh.events.map(e => e.seq)).toEqual([5])
  })
})
