import { describe, it, expect, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useLiveSession } from './useLiveSession.js'
import { EventStreamClient, type EventSourceLike } from './EventStreamClient.js'
import { ApiClient } from '../api/client.js'
import type { AkisEvent } from '@akis/shared'

class FakeEventSource implements EventSourceLike {
  onmessage: ((ev: { data: string; lastEventId: string }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  private named = new Map<string, (ev: { data: string }) => void>()
  closed = false
  readyState = 1
  constructor(readonly url: string) {}
  addEventListener(type: string, fn: (ev: { data: string }) => void): void { this.named.set(type, fn) }
  close(): void { this.closed = true }
  msg(event: object, seq: number): void { this.onmessage?.({ data: JSON.stringify(event), lastEventId: String(seq) }) }
  named_(type: string, data: object): void { this.named.get(type)?.({ data: JSON.stringify(data) }) }
}

const E = (kind: string, over: object = {}): AkisEvent =>
  ({ kind, agent: 'orchestrator', laneId: 'main', sessionId: 's1', ts: 0, ...over }) as AkisEvent

function setup(logFetch?: (path: string) => unknown) {
  let es: FakeEventSource | undefined
  const makeClient = (): EventStreamClient => new EventStreamClient(url => (es = new FakeEventSource(url)))
  const fetchFn = vi.fn((path: string) =>
    Promise.resolve({ ok: true, status: 200, json: async () => (logFetch ? logFetch(path) : {}), text: async () => '' } as unknown as Response))
  const api = new ApiClient('', fetchFn)
  const hook = renderHook(() => useLiveSession('s1', api, '', makeClient))
  return { hook, es: () => es!, api, fetchFn }
}

describe('useLiveSession', () => {
  it('projects live events into the view', async () => {
    const { hook, es } = setup()
    act(() => {
      es().msg(E('agent_start', { role: 'scribe', agent: 'scribe' }), 1)
      es().msg(E('gate', { gate: 'spec_approval', state: 'awaiting' }), 2)
    })
    await waitFor(() => expect(hook.result.current?.lanes.length).toBe(1))
    expect(hook.result.current?.gates.specApproval?.state).toBe('awaiting')
  })

  it('is idempotent over duplicate seqs (no doubled steps)', async () => {
    const { hook, es } = setup()
    act(() => {
      es().msg(E('agent_start', { role: 'scribe', agent: 'scribe' }), 1)
      es().msg(E('agent_start', { role: 'scribe', agent: 'scribe' }), 1) // same seq → dedup
    })
    await waitFor(() => expect(hook.result.current).toBeDefined())
    expect(hook.result.current!.lanes[0]!.steps).toHaveLength(1)
  })

  it('on reset, rebuilds the view from the log instead of blanking it (F2-AC12)', async () => {
    // The server dropped its buffer; the log endpoint returns the retained history.
    const log = {
      events: [
        { seq: 1, event: E('agent_start', { role: 'scribe', agent: 'scribe' }) },
        { seq: 2, event: E('gate', { gate: 'spec_approval', state: 'satisfied' }) },
      ],
      head: 2,
    }
    const { hook, es } = setup(() => log)
    act(() => { es().msg(E('text', { text: 'hi' }), 1) })
    await waitFor(() => expect(hook.result.current).toBeDefined())
    act(() => { es().named_('reset', { head: 2 }) })
    // After reset the view must reflect the refetched log — NOT collapse to empty.
    await waitFor(() => expect(hook.result.current?.gates.specApproval?.state).toBe('satisfied'))
    expect(hook.result.current!.lanes[0]!.steps[0]!.agent).toBe('scribe')
  })

  it('closes the stream on unmount (no listener leak)', () => {
    const { hook, es } = setup()
    hook.unmount()
    expect(es().closed).toBe(true)
  })
})
