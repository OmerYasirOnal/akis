import type { AkisEvent } from '@akis/shared'

/** An event with its per-session monotonic transport sequence number. */
export interface SeqEvent {
  seq: number
  event: AkisEvent
}

/** Listeners may take just the event (back-compat) or also the transport `seq`. */
type Listener = (e: AkisEvent, seq: number) => void

/** Result of a resume query: the tail after a cursor, plus whether the buffer
 *  had already evicted events the client still needed (so it must re-sync). */
export interface ReplayResult {
  dropped: boolean
  events: SeqEvent[]
}

/**
 * In-memory event hub. Each event gets a **per-session monotonic `seq`** assigned
 * at emit time — the transport cursor that makes the SSE stream resumable
 * (F2-AC12): a reconnecting client sends its last `seq` and the server replays
 * only what came after. `seq` is deliberately NOT part of the `AkisEvent` shape
 * (that is the domain event, stamped with the logical `ts`); the bus owns the
 * transport numbering.
 *
 * The buffer is bounded (`cap`); when it overflows the oldest events are evicted
 * and `replaySince` reports `dropped` so the client re-syncs from session state
 * instead of silently losing steps.
 */
export class EventBus {
  private listeners = new Map<string, Set<Listener>>()
  private buffers = new Map<string, SeqEvent[]>()
  private seqs = new Map<string, number>()
  constructor(private readonly cap = 200) {}

  subscribe(sessionId: string, fn: Listener): () => void {
    const set = this.listeners.get(sessionId) ?? new Set()
    set.add(fn); this.listeners.set(sessionId, set)
    return () => set.delete(fn)
  }

  emit(e: AkisEvent): void {
    const seq = (this.seqs.get(e.sessionId) ?? 0) + 1
    this.seqs.set(e.sessionId, seq)
    const buf = this.buffers.get(e.sessionId) ?? []
    buf.push({ seq, event: e })
    if (buf.length > this.cap) buf.splice(0, buf.length - this.cap)
    this.buffers.set(e.sessionId, buf)
    // A broken subscriber (e.g. an SSE write to a dead socket) must NOT stop the
    // other listeners for this event, nor throw back into the producer that
    // emitted it. Cleanup is the subscriber's own responsibility.
    this.listeners.get(e.sessionId)?.forEach(fn => {
      try { fn(e, seq) } catch { /* isolate a faulty listener */ }
    })
  }

  /** Plain event list (back-compat for non-resumable consumers). */
  recent(sessionId: string): AkisEvent[] {
    return (this.buffers.get(sessionId) ?? []).map(s => s.event)
  }

  /** Highest `seq` assigned for the session (0 if none) — the live head cursor. */
  head(sessionId: string): number {
    return this.seqs.get(sessionId) ?? 0
  }

  /**
   * Buffered events with `seq > afterSeq`, in order. `dropped` is true when the
   * next event the client needs (`afterSeq + 1`) was already evicted — i.e. the
   * buffer no longer covers the gap, so the client must re-sync from session
   * state rather than resume in place.
   */
  replaySince(sessionId: string, afterSeq: number): ReplayResult {
    const buf = this.buffers.get(sessionId) ?? []
    const events = buf.filter(s => s.seq > afterSeq)
    const oldest = buf[0]?.seq
    const dropped = oldest !== undefined && afterSeq + 1 < oldest
    return { dropped, events }
  }
}
