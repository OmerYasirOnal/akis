import { useEffect, useRef, useState } from 'react'
import type { AkisEvent } from '@akis/shared'
import { ApiClient } from '../api/client.js'
import { EventStreamClient } from '../live/EventStreamClient.js'
import { foldSessionView, emptyView } from '../live/viewModel.js'
import type { SessionView } from '../live/types.js'
import { foldChat, type ChatMessage } from './chatModel.js'

export interface LiveChat { messages: ChatMessage[]; view: SessionView }

/**
 * Subscribe a session's live stream once and project it into BOTH a chat thread
 * (chronological) and the aggregated SessionView (for the side rail + gate state).
 * Events are keyed by transport seq → idempotent across replay/reconnect; on a
 * `reset` it re-syncs from GET /sessions/:id/log (F2-AC12).
 */
export function useLiveChat(sessionId: string | undefined, idea: string, api: ApiClient, baseUrl = '', makeClient?: () => EventStreamClient): LiveChat {
  const [state, setState] = useState<LiveChat>({ messages: [], view: emptyView(sessionId ?? '') })
  const bySeq = useRef<Map<number, AkisEvent>>(new Map())

  useEffect(() => {
    if (!sessionId) { setState({ messages: [], view: emptyView('') }); return }
    let cancelled = false
    bySeq.current = new Map()
    const client = (makeClient ?? (() => new EventStreamClient()))()
    const refold = (): void => {
      if (cancelled) return
      const ordered = [...bySeq.current.entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => e)
      setState({ messages: foldChat(idea, ordered), view: foldSessionView(sessionId, ordered) })
    }
    client.connect(`${baseUrl}/sessions/${sessionId}/events`, {
      onEvent: (e, seq) => { bySeq.current.set(seq, e); refold() },
      onReset: () => { bySeq.current = new Map(); void api.getSessionLog(sessionId).then(log => { if (cancelled) return; for (const { seq, event } of log) bySeq.current.set(seq, event); refold() }).catch(() => {}) },
    })
    refold() // render the user-idea bubble immediately, before the first event arrives
    return () => { cancelled = true; client.close() }
  }, [sessionId, idea, api, baseUrl, makeClient])

  return state
}
