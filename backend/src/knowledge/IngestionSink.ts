import type { AkisEvent } from '@akis/shared'
import type { EventBus } from '../events/bus.js'
import type { RagService, IngestInput } from './RagService.js'

export interface IngestionSinkDeps {
  bus: EventBus
  rag: RagService
  userIdFor: (sessionId: string) => string
}

/**
 * Zero-touch ingestion (F1-AC1/AC2): subscribes the AkisEvent bus for a session and
 * enqueues ingestible content as it is emitted — no polling, no FE-synthesized events,
 * the bus is the single source. Subscribing happens AS the session starts (F1-AC17),
 * so nothing emitted after start is missed. Ingestion is off the agent path (the
 * RagService enqueues; the agent run never waits).
 */
export class IngestionSink {
  constructor(private deps: IngestionSinkDeps) {}

  /** Subscribe a session; returns an unsubscribe handle. Call at session start.
   *  Self-unsubscribes on a terminal event (done / session failed) so a long-running
   *  server never accumulates dead listeners (bounds the subscription to the session). */
  subscribeSession(sessionId: string): () => void {
    const userId = this.deps.userIdFor(sessionId)
    let unsub: () => void = () => {}
    unsub = this.deps.bus.subscribe(sessionId, event => {
      const input = this.toIngest(event, sessionId, userId)
      if (input) this.deps.rag.ingest(input)
      if (event.kind === 'done' || (event.kind === 'session' && event.status === 'failed')) unsub()
    })
    return unsub
  }

  /** Map an event to ingestible content, or null if it carries nothing to ingest. */
  private toIngest(event: AkisEvent, sessionId: string, userId: string): IngestInput | null {
    if (event.kind === 'text' && event.text.trim()) {
      return { text: event.text, source: 'conversation', sourceId: sessionId, userId, sessionId, agent: event.agent }
    }
    return null
  }
}
