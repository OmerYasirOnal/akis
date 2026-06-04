import { describe, it, expect, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useLiveChat } from './useLiveChat.js'
import { EventStreamClient, type EventSourceLike } from '../live/EventStreamClient.js'
import { ApiClient } from '../api/client.js'
import type { AkisEvent } from '@akis/shared'

/** A controllable fake EventSource (mirrors useLiveSession.test). */
class FakeEventSource implements EventSourceLike {
  onmessage: ((ev: { data: string; lastEventId: string }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  private named = new Map<string, (ev: { data: string }) => void>()
  closed = false
  readyState = 1
  constructor(readonly url: string) {}
  addEventListener(type: string, fn: (ev: { data: string }) => void): void { this.named.set(type, fn) }
  close(): void { this.closed = true; this.readyState = 2 }
  msg(event: object, seq: number): void { this.onmessage?.({ data: JSON.stringify(event), lastEventId: String(seq) }) }
  err(): void { this.onerror?.({}) } // transient: readyState stays OPEN (browser auto-retries)
}

const E = (kind: string, over: object = {}): AkisEvent =>
  ({ kind, agent: 'orchestrator', laneId: 'main', sessionId: 's1', ts: 0, ...over }) as AkisEvent

function setup() {
  let es: FakeEventSource | undefined
  const makeClient = (): EventStreamClient => new EventStreamClient(url => (es = new FakeEventSource(url)))
  const fetchFn = vi.fn(() => Promise.resolve({ ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response))
  const api = new ApiClient('', fetchFn)
  const hook = renderHook(() => useLiveChat('s1', 'todo app', api, '', makeClient))
  return { hook, es: () => es! }
}

describe('useLiveChat — SSE-drop reconnecting overlay', () => {
  it('does not flag connectionLost while the stream is live', async () => {
    const { hook, es } = setup()
    act(() => { es().msg(E('agent_start', { role: 'scribe', agent: 'scribe' }), 1) })
    await waitFor(() => expect(hook.result.current.view.lanes.length).toBe(1))
    expect(hook.result.current.view.connectionLost).toBeFalsy()
  })

  it('an SSE error flags connectionLost (reconnecting banner), distinct from a failed run', async () => {
    const { hook, es } = setup()
    act(() => { es().msg(E('agent_start', { role: 'scribe', agent: 'scribe' }), 1) })
    await waitFor(() => expect(hook.result.current.view.lanes.length).toBe(1))
    act(() => { es().err() })
    await waitFor(() => expect(hook.result.current.view.connectionLost).toBe(true))
    // It's a transport flag, NOT a terminal failure: status is unchanged (still running).
    expect(hook.result.current.view.status).not.toBe('failed')
  })

  it('clears connectionLost on the next delivered event, deduped by seq (no double-count on resume)', async () => {
    const { hook, es } = setup()
    act(() => { es().msg(E('agent_start', { role: 'scribe', agent: 'scribe' }), 1) })
    await waitFor(() => expect(hook.result.current.view.lanes.length).toBe(1))
    act(() => { es().err() })
    await waitFor(() => expect(hook.result.current.view.connectionLost).toBe(true))
    // The resumable EventSource replays from Last-Event-ID; seq 1 is re-delivered (dedup) and a
    // new seq 2 arrives. The flag clears and steps are not doubled.
    act(() => {
      es().msg(E('agent_start', { role: 'scribe', agent: 'scribe' }), 1) // same seq → deduped
      es().msg(E('agent_end', { role: 'scribe', ok: true, agent: 'scribe' }), 2)
    })
    await waitFor(() => expect(hook.result.current.view.connectionLost).toBeFalsy())
    expect(hook.result.current.view.lanes[0]!.steps).toHaveLength(1) // not doubled
    expect(hook.result.current.view.lanes[0]!.steps[0]!.done).toBe(true)
  })
})
