import { useEffect, useRef, useState } from 'react'
import type { AkisEvent } from '@akis/shared'
import { ApiClient } from '../api/client.js'
import { EventStreamClient } from '../live/EventStreamClient.js'
import { foldSessionView, emptyView } from '../live/viewModel.js'
import type { SessionView } from '../live/types.js'
import { foldChat, type ChatMessage } from './chatModel.js'

export interface LiveChat { messages: ChatMessage[]; view: SessionView }

/** Max manual reconnect attempts for a CLOSED (non-auto-retrying) SSE stream before giving up. */
const MAX_RECONNECT = 6

/**
 * Subscribe a session's live stream once and project it into BOTH a chat thread
 * (chronological) and the aggregated SessionView (for the side rail + gate state).
 * Events are keyed by transport seq → idempotent across replay/reconnect; on a
 * `reset` it re-syncs from GET /sessions/:id/log (F2-AC12).
 */
export function useLiveChat(sessionId: string | undefined, idea: string, api: ApiClient, baseUrl = '', makeClient?: () => EventStreamClient): LiveChat {
  const [state, setState] = useState<LiveChat>({ messages: [], view: emptyView(sessionId ?? '') })
  const bySeq = useRef<Map<number, AkisEvent>>(new Map())
  // TRANSPORT state, overlaid onto the folded view (so foldSessionView stays pure): the SSE
  // stream dropped and the resumable EventSource is reconnecting (Last-Event-ID/seq, no double
  // counting). Drives the subtle "reconnecting" banner; cleared on the next delivered event.
  const lostRef = useRef(false)

  useEffect(() => {
    if (!sessionId) { setState({ messages: [], view: emptyView('') }); return }
    let cancelled = false
    let attempts = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let client: EventStreamClient | undefined
    bySeq.current = new Map()
    lostRef.current = false
    const refold = (): void => {
      if (cancelled) return
      const ordered = [...bySeq.current.entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => e)
      const view = foldSessionView(sessionId, ordered)
      setState({ messages: foldChat(idea, ordered), view: { ...view, ...(lostRef.current ? { connectionLost: true } : {}) } })
    }
    const connect = (): void => {
      client = (makeClient ?? (() => new EventStreamClient()))()
      client.connect(`${baseUrl}/sessions/${sessionId}/events`, {
        // A delivered event means the stream is live again → clear the reconnecting flag + reset
        // the backoff. The event is keyed by seq, so a resumed/replayed event is deduped.
        onEvent: (e, seq) => { attempts = 0; lostRef.current = false; bySeq.current.set(seq, e); refold() },
        onReset: () => { lostRef.current = false; bySeq.current = new Map(); void api.getSessionLog(sessionId).then(log => { if (cancelled) return; for (const { seq, event } of log) bySeq.current.set(seq, event); refold() }).catch(() => {}) },
        // SSE dropped: mark reconnecting (subtle banner). A CONNECTING source the browser auto-
        // resumes via Last-Event-ID (the next onEvent clears the flag). A CLOSED source will NOT
        // retry (e.g. a 404), so reconnect it manually with capped backoff — a fresh connection
        // + the server's reset/log re-syncs — instead of leaving the banner stuck forever.
        onError: ({ closed }) => {
          if (cancelled) return
          if (!lostRef.current) { lostRef.current = true; refold() }
          if (closed && attempts < MAX_RECONNECT) {
            attempts++
            timer = setTimeout(() => { if (cancelled) return; client?.close(); connect() }, Math.min(1500 * attempts, 8000))
          }
        },
      })
    }
    connect()
    refold() // render the user-idea bubble immediately, before the first event arrives
    return () => { cancelled = true; if (timer) clearTimeout(timer); client?.close() }
  }, [sessionId, idea, api, baseUrl, makeClient])

  return state
}
