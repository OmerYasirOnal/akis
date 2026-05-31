import { describe, it, expect } from 'vitest'
import { EventBus } from '../../src/events/bus.js'
import type { AkisEvent } from '@akis/shared'

const ev = (over: Partial<AkisEvent> = {}): AkisEvent =>
  ({ sessionId: 's1', agent: 'orchestrator', laneId: 'main', ts: 1, kind: 'text', text: 'hi', ...over } as AkisEvent)

describe('EventBus', () => {
  it('emits to subscribers and records to the ring buffer', () => {
    const bus = new EventBus(10)
    const seen: AkisEvent[] = []
    bus.subscribe('s1', e => seen.push(e))
    bus.emit(ev())
    expect(seen).toHaveLength(1)
    expect(bus.recent('s1')).toHaveLength(1)
  })
  it('caps the ring buffer', () => {
    const bus = new EventBus(2)
    for (let i = 0; i < 5; i++) bus.emit(ev({ ts: i }))
    expect(bus.recent('s1')).toHaveLength(2)
    expect(bus.recent('s1')[0].ts).toBe(3)
  })
})
