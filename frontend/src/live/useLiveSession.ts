import { useEffect, useRef, useState } from 'react'
import type { AkisEvent } from '@akis/shared'
import { ApiClient } from '../api/client.js'
import { EventStreamClient } from './EventStreamClient.js'
import { foldSessionView } from './viewModel.js'
import type { SessionView } from './types.js'

/**
 * Subscribe a session's live event stream and project it into a SessionView.
 * Holds the raw event log and re-folds on each event (the fold is cheap + pure).
 * On a `reset` it clears and refetches GET /sessions/:id (no lost/dup — F2-AC12).
 */
export function useLiveSession(sessionId: string | undefined, api: ApiClient, baseUrl = ''): SessionView | undefined {
  const [view, setView] = useState<SessionView | undefined>(undefined)
  const events = useRef<AkisEvent[]>([])

  useEffect(() => {
    if (!sessionId) { setView(undefined); return }
    events.current = []
    const client = new EventStreamClient()
    const refold = (): void => setView(foldSessionView(sessionId, events.current))
    client.connect(`${baseUrl}/sessions/${sessionId}/events`, {
      onEvent: e => { events.current.push(e); refold() },
      onReset: () => { events.current = []; void api.getSession(sessionId).then(refold) },
    })
    return () => client.close()
  }, [sessionId, api, baseUrl])

  return view
}
