import { useEffect, useRef, useState } from 'react'
import type { AkisEvent } from '@akis/shared'
import { ApiClient } from '../api/client.js'
import { EventStreamClient } from './EventStreamClient.js'
import { foldSessionView } from './viewModel.js'
import type { SessionView } from './types.js'

/**
 * Subscribe a session's live event stream and project it into a SessionView.
 *
 * Events are keyed by their transport `seq` (a Map), so replays/reconnects are
 * idempotent — a step is never duplicated. On an SSE `reset` (the server buffer
 * dropped) the FE refetches the authoritative retained log (`GET /sessions/:id/log`),
 * merges it into the same seq-keyed map, and re-folds — so the view is rebuilt, not
 * blanked, and resumes live from head (no lost/duplicated steps — F2-AC12).
 */
export function useLiveSession(
  sessionId: string | undefined,
  api: ApiClient,
  baseUrl = '',
  makeClient: () => EventStreamClient = () => new EventStreamClient(),
): SessionView | undefined {
  const [view, setView] = useState<SessionView | undefined>(undefined)
  const bySeq = useRef<Map<number, AkisEvent>>(new Map())

  useEffect(() => {
    if (!sessionId) { setView(undefined); return }
    let cancelled = false
    bySeq.current = new Map()
    const client = makeClient()

    const refold = (): void => {
      if (cancelled) return
      const ordered = [...bySeq.current.entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => e)
      setView(foldSessionView(sessionId, ordered))
    }

    client.connect(`${baseUrl}/sessions/${sessionId}/events`, {
      onEvent: (e, seq) => { bySeq.current.set(seq, e); refold() },
      onReset: data => {
        client.lastSeq = data.head // observability only — EventSource owns Last-Event-ID (advanced by the reset frame's id:)
        void api.getSessionLog(sessionId).then(log => {
          if (cancelled) return
          for (const { seq, event } of log) bySeq.current.set(seq, event) // merge (dedup by seq)
          refold()
        }).catch(() => { /* re-sync best-effort; live stream keeps filling the map */ })
      },
    })

    return () => { cancelled = true; client.close() }
  }, [sessionId, api, baseUrl, makeClient])

  return view
}
