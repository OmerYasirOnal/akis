import { describe, it, expect, vi } from 'vitest'
import { EventStreamClient, type EventSourceLike, type EventSourceFactory } from './EventStreamClient.js'
import type { AkisEvent } from '@akis/shared'

/** A controllable fake EventSource. */
class FakeEventSource implements EventSourceLike {
  onmessage: ((ev: { data: string; lastEventId: string }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  private named = new Map<string, (ev: { data: string }) => void>()
  closed = false
  readyState = 1
  constructor(readonly url: string) {}
  addEventListener(type: string, fn: (ev: { data: string }) => void): void { this.named.set(type, fn) }
  close(): void { this.closed = true }
  // test helpers
  emitMessage(data: string, lastEventId: string): void { this.onmessage?.({ data, lastEventId }) }
  emitNamed(type: string, data: string): void { this.named.get(type)?.({ data }) }
}

const ev = (kind: string, seq: number): { frame: string; seq: string } => ({
  frame: JSON.stringify({ kind, text: `m${seq}`, agent: 'orchestrator', laneId: 'main', sessionId: 's1', ts: seq }),
  seq: String(seq),
})

describe('EventStreamClient', () => {
  it('delivers parsed events in order and tracks the last seq', () => {
    let made: FakeEventSource | undefined
    const factory: EventSourceFactory = url => (made = new FakeEventSource(url))
    const got: AkisEvent[] = []
    const client = new EventStreamClient(factory)
    client.connect('/sessions/s1/events', { onEvent: e => got.push(e) })
    const a = ev('text', 1); made!.emitMessage(a.frame, a.seq)
    const b = ev('gate', 2); made!.emitMessage(b.frame, b.seq)
    expect(got.map(e => e.kind)).toEqual(['text', 'gate'])
    expect(client.lastSeq).toBe(2)
    expect(made!.url).toContain('/sessions/s1/events')
  })

  it('invokes onReset for a reset control frame', () => {
    let made: FakeEventSource | undefined
    const factory: EventSourceFactory = url => (made = new FakeEventSource(url))
    const onReset = vi.fn()
    const client = new EventStreamClient(factory)
    client.connect('/sessions/s1/events', { onEvent: () => {}, onReset })
    made!.emitNamed('reset', JSON.stringify({ head: 7 }))
    expect(onReset).toHaveBeenCalledWith({ head: 7 })
  })

  it('close() closes the underlying source', () => {
    let made: FakeEventSource | undefined
    const factory: EventSourceFactory = url => (made = new FakeEventSource(url))
    const client = new EventStreamClient(factory)
    client.connect('/sessions/s1/events', { onEvent: () => {} })
    client.close()
    expect(made!.closed).toBe(true)
  })

  it('ignores malformed frames without throwing', () => {
    let made: FakeEventSource | undefined
    const factory: EventSourceFactory = url => (made = new FakeEventSource(url))
    const got: AkisEvent[] = []
    const client = new EventStreamClient(factory)
    client.connect('/x', { onEvent: e => got.push(e) })
    expect(() => made!.emitMessage('not json', '1')).not.toThrow()
    expect(got).toHaveLength(0)
  })
})
