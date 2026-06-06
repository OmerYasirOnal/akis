import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventBus } from '../../src/events/bus.js'
import type { AkisEvent } from '@akis/shared'

/**
 * MEMORY QUICK-WIN (optimization audit): buffers/seqs only ever GREW — every build that ever ran
 * stayed resident for the process lifetime. The bus now schedules a graced eviction on the same
 * terminal events the UsageCollector already prunes on (kind:'done' + session failed/cancelled/done),
 * and ANY new event for the session cancels the pending eviction (a retry/iterate revives it).
 * replaySince/log already tolerate an evicted buffer (dropped → client re-sync), so nothing breaks.
 */
const base = { agent: 'orchestrator' as const, laneId: 'main', ts: 1 }
const textEv = (sessionId: string): AkisEvent => ({ ...base, kind: 'text', sessionId, text: 'x' })
const doneEv = (sessionId: string): AkisEvent => ({ ...base, kind: 'done', sessionId, verified: true, provider: 'mock' })
const failedEv = (sessionId: string): AkisEvent => ({ ...base, kind: 'session', sessionId, status: 'failed' })

describe('EventBus terminal eviction (bounded process-lifetime memory)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('evicts the buffer + seq AFTER the grace once the run terminates (done)', () => {
    const bus = new EventBus()
    bus.emit(textEv('s1')); bus.emit(doneEv('s1'))
    expect(bus.recent('s1')).toHaveLength(2) // grace window: the final /log replay still works
    vi.advanceTimersByTime(60_001)
    expect(bus.recent('s1')).toHaveLength(0) // evicted — no permanent residency
    expect(bus.head('s1')).toBe(0)
  })

  it('a failed/cancelled session evicts too (the same terminal semantics UsageCollector prunes on)', () => {
    const bus = new EventBus()
    bus.emit(failedEv('s2'))
    vi.advanceTimersByTime(60_001)
    expect(bus.head('s2')).toBe(0)
  })

  it('a NEW event during the grace CANCELS the eviction (a retry/iterate revives the session)', () => {
    const bus = new EventBus()
    bus.emit(doneEv('s3'))
    vi.advanceTimersByTime(30_000)
    bus.emit(textEv('s3'))            // retry woke the session inside the grace
    vi.advanceTimersByTime(60_000)    // well past the ORIGINAL deadline
    expect(bus.recent('s3').length).toBeGreaterThan(0) // still resident (no terminal since)
  })

  it('a non-terminal stream never evicts', () => {
    const bus = new EventBus()
    bus.emit(textEv('s4'))
    vi.advanceTimersByTime(600_000)
    expect(bus.recent('s4')).toHaveLength(1)
  })
})
