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
   *  Self-unsubscribes on a terminal event (done / session failed-or-cancelled) so a
   *  long-running server never accumulates dead listeners (bounds it to the session). */
  subscribeSession(sessionId: string): () => void {
    const userId = this.deps.userIdFor(sessionId)
    let unsub: () => void = () => {}
    unsub = this.deps.bus.subscribe(sessionId, event => {
      const input = this.toIngest(event, sessionId, userId)
      if (input) this.deps.rag.ingest(input)
      if (event.kind === 'done' || (event.kind === 'session' && (event.status === 'failed' || event.status === 'cancelled'))) unsub()
    })
    return unsub
  }

  /** Map an event to ingestible content, or null if it carries nothing to ingest.
   *  Ephemeral text (free-form/untrusted narration, e.g. advisory-agent notes) is
   *  shown live but NEVER ingested — it must not become trusted RAG grounding that
   *  is replayed into core-producer prompts (closes the advisory→RAG injection loop). */
  private toIngest(event: AkisEvent, sessionId: string, userId: string): IngestInput | null {
    if (event.kind === 'text' && !event.ephemeral && event.text.trim()) {
      return { text: event.text, source: 'conversation', sourceId: sessionId, userId, sessionId, agent: event.agent }
    }
    return null
  }
}
