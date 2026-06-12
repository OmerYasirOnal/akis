import { describe, it, expect, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useLiveChat } from './useLiveChat.js'
import { EventStreamClient, type EventSourceLike } from '../live/EventStreamClient.js'
import { ApiClient } from '../api/client.js'
import type { AkisEvent } from '@akis/shared'

/** A controllable fake EventSource (mirrors useLiveSession.test). */
class FakeEventSource implements EventSourceLike {
  onmessage: ((ev: { data: string; lastEventId: string }) => void) | null = null
  onopen: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  private named = new Map<string, (ev: { data: string }) => void>()
  closed = false
  readyState = 1
  constructor(readonly url: string) {}
  addEventListener(type: string, fn: (ev: { data: string }) => void): void { this.named.set(type, fn) }
  close(): void { this.closed = true; this.readyState = 2 }
  open(): void { this.onopen?.({}) } // connection established (clears the reconnecting banner)
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

  it('a successful (re)connect OPEN clears the reconnecting banner even with NO following event (quiescent gate)', async () => {
    const { hook, es } = setup()
    act(() => { es().msg(E('gate', { gate: 'push_confirm', state: 'awaiting' }), 1) })
    act(() => { es().err() }) // stream drops at a parked gate
    await waitFor(() => expect(hook.result.current.view.connectionLost).toBe(true))
    // The reconnect establishes but the gate is quiescent — nothing more is emitted. onOpen alone
    // must clear the banner (previously it pulsed forever waiting for an event/reset that never came).
    act(() => { es().open() })
    await waitFor(() => expect(hook.result.current.view.connectionLost).toBeFalsy())
  })

  it('manually reconnects a CLOSED stream (closes the old, opens a new) with capped backoff', () => {
    vi.useFakeTimers()
    try {
      const created: FakeEventSource[] = []
      const makeClient = (): EventStreamClient => new EventStreamClient(url => { const es = new FakeEventSource(url); created.push(es); return es })
      const fetchFn = vi.fn(() => Promise.resolve({ ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response))
      const api = new ApiClient('', fetchFn)
      const hook = renderHook(() => useLiveChat('s1', 'todo app', api, '', makeClient))
      expect(created).toHaveLength(1)
      const first = created[0]!
      // A CLOSED EventSource (readyState 2) will NOT auto-retry → the hook must reconnect manually.
      act(() => { first.readyState = 2; first.err() })
      expect(hook.result.current.view.connectionLost).toBe(true) // banner while reconnecting
      act(() => { vi.advanceTimersByTime(1600) })                // first backoff is ~1500ms
      expect(first.closed).toBe(true)                            // the OLD source is closed first
      expect(created.length).toBeGreaterThanOrEqual(2)           // a NEW source opened (no double-connect)
      // Cleanup clears the pending backoff timer → no post-unmount reconnect.
      const before = created.length
      act(() => { created[created.length - 1]!.readyState = 2; created[created.length - 1]!.err() })
      hook.unmount()
      act(() => { vi.advanceTimersByTime(10000) })
      expect(created.length).toBe(before) // unmount stopped the chain
    } finally {
      vi.useRealTimers()
    }
  })

  it('exhausted reconnects flip the TERMINAL connectionGone flag (the give-up is visible)', () => {
    vi.useFakeTimers()
    try {
      const created: FakeEventSource[] = []
      const makeClient = (): EventStreamClient => new EventStreamClient(url => { const es = new FakeEventSource(url); created.push(es); return es })
      const fetchFn = vi.fn(() => Promise.resolve({ ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response))
      const api = new ApiClient('', fetchFn)
      const hook = renderHook(() => useLiveChat('s1', 'todo app', api, '', makeClient))
      // Exhaust every manual reconnect: fail each CLOSED source in turn.
      for (let round = 0; round < 12 && hook.result.current.view.connectionGone !== true; round++) {
        const cur = created[created.length - 1]!
        act(() => { cur.readyState = 2; cur.err() })
        act(() => { vi.advanceTimersByTime(9000) })
      }
      expect(hook.result.current.view.connectionGone).toBe(true)
      expect(hook.result.current.view.connectionLost).toBe(true)
      // A delivered event afterwards clears BOTH (the stream genuinely came back).
      const last = created[created.length - 1]
      if (last) {
        // onEvent now coalesces via requestAnimationFrame — advance the (faked) timer so the
        // batched refold flushes before asserting the flag cleared.
        act(() => { last.msg(E('narration', { text: 'hi', ts: 1 }), 1); vi.advanceTimersByTime(20) })
        expect(hook.result.current.view.connectionGone).not.toBe(true)
      }
    } finally {
      vi.useRealTimers()
    }
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

// ── F10 — a LIVE tab surviving a backend restart auto-reconnects via Last-Event-ID; replaySince
//    returns ONLY post-cursor frames, so a preview_status BEFORE the cursor is never replayed and the
//    replay-time liveness projection has no frame to correct — a dead 'ready' iframe persists. On a
//    RE-open (an open after a prior successful open) the hook re-fetches the FULL /log (which DOES run
//    through the backend projection), folding in the projected 'stopped' truth. ──
describe('useLiveChat — F10 resumed-live-tab re-open re-syncs the projected /log', () => {
  it('a RE-open re-fetches /log so a backend-projected stopped preview folds in (dead ready corrected)', async () => {
    let es: FakeEventSource | undefined
    const makeClient = (): EventStreamClient => new EventStreamClient(url => (es = new FakeEventSource(url)))
    // The /log GET returns the BACKEND-PROJECTED truth: the post-restart registry can't back the
    // earlier 'ready', so the projection rewrote seq 1 to 'stopped' (url stripped). Same seq → it
    // overlays the stale live-tapped 'ready' in the hook's by-seq map.
    const projectedLog = { events: [{ seq: 1, event: E('preview_status', { status: 'stopped' }) }], head: 1 }
    const fetchFn = vi.fn(async (path: string) =>
      ({ ok: true, status: 200, json: async () => (path.endsWith('/log') ? projectedLog : {}), text: async () => '' }) as unknown as Response)
    const api = new ApiClient('', fetchFn)
    const hook = renderHook(() => useLiveChat('s1', 'todo app', api, '', makeClient))

    // The live tab learns a 'ready' preview (the iframe embeds /preview/s1/).
    act(() => { es!.open() }) // initial open (opened := true, no re-sync)
    act(() => { es!.msg(E('preview_status', { status: 'ready', url: '/preview/s1/' }), 1) })
    await waitFor(() => expect(hook.result.current.view.preview.ready).toBe(true))

    // Backend restarts: the EventSource auto-reconnects → a SECOND open. F10: this re-opens triggers
    // the /log re-fetch; the projected 'stopped' frame overlays seq 1 and the dead 'ready' is corrected.
    act(() => { es!.open() })
    await waitFor(() => expect(hook.result.current.view.preview.ready).toBe(false))
    expect(hook.result.current.view.preview.stopped).toBe(true)
    expect(hook.result.current.view.preview.url).toBeUndefined() // no dead iframe url
    expect(fetchFn.mock.calls.some(c => String(c[0]).endsWith('/sessions/s1/log'))).toBe(true)
  })

  it('the FIRST open does NOT re-fetch /log (initial connect already folds; events stream normally)', async () => {
    let es: FakeEventSource | undefined
    const makeClient = (): EventStreamClient => new EventStreamClient(url => (es = new FakeEventSource(url)))
    const fetchFn = vi.fn(async (_path: string) => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response))
    const api = new ApiClient('', fetchFn)
    renderHook(() => useLiveChat('s1', 'todo app', api, '', makeClient))
    act(() => { es!.open() }) // the ONLY open → must NOT trigger a /log re-fetch
    await Promise.resolve()
    expect(fetchFn.mock.calls.some(c => String(c[0]).endsWith('/sessions/s1/log'))).toBe(false)
  })
})

describe('useLiveChat — rAF coalescer (perf invariant #50)', () => {
  it('coalesces N events delivered in one frame into a SINGLE refold (not one per event)', () => {
    vi.useFakeTimers()
    try {
      const { hook, es } = setup()
      // Three events arrive synchronously (same frame). The coalescer must BATCH them — no refold
      // fires per event (a fast build streams ~100 notes/sec; per-event refold would thrash).
      act(() => {
        es().msg(E('agent_start', { role: 'scribe', agent: 'scribe' }), 1)
        es().msg(E('narration', { text: 'a', ts: 1 }), 2)
        es().msg(E('agent_end', { role: 'scribe', ok: true, agent: 'scribe' }), 3)
      })
      // BEFORE the frame flushes: the batched refold has NOT run → the view is still empty.
      expect(hook.result.current.view.lanes.length).toBe(0)
      // Flush the SINGLE coalesced animation frame.
      act(() => { vi.advanceTimersByTime(20) })
      // ONE refold reflects ALL three events (scribe start+end → one done step).
      expect(hook.result.current.view.lanes.length).toBe(1)
      expect(hook.result.current.view.lanes[0]!.steps[0]!.done).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
