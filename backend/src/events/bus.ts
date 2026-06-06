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
  private taps = new Set<Listener>()
  /** Per-session replay buffer. Map insertion order = LRU recency (re-inserted on every emit),
   *  so when the session count exceeds {@link maxSessions} the OLDEST session's buffer is dropped.
   *  This BOUNDS memory (the audit's concern) WITHOUT a time-evict that broke reopen of a recently
   *  finished build (a HIGH lifecycle regression): the most-recent maxSessions builds always replay. */
  private buffers = new Map<string, SeqEvent[]>()
  /** Seq HIGH-WATER mark per session — kept even after a buffer is LRU-evicted, so head() stays
   *  truthful and replaySince() can detect "events existed but the buffer is gone" (dropped:true). */
  private seqs = new Map<string, number>()
  constructor(private readonly cap = 200, private readonly maxSessions = 200) {}

  /** Dev persistence seam: dump every session's retained buffer + seq head as plain JSON.
   *  Buffers are already per-session capped, so a snapshot is bounded by design. */
  snapshot(): { seqs: Record<string, number>; buffers: Record<string, SeqEvent[]> } {
    return {
      seqs: Object.fromEntries(this.seqs),
      buffers: Object.fromEntries([...this.buffers.entries()].map(([k, v]) => [k, v.map(e => ({ ...e }))])),
    }
  }
  /** Boot-time hydrate from a snapshot (tolerant: malformed shapes are dropped). Restores
   *  seq heads so resumed SSE/Last-Event-ID semantics stay correct across a dev restart. */
  hydrate(data: { seqs?: Record<string, number>; buffers?: Record<string, SeqEvent[]> }): void {
    if (data.seqs && typeof data.seqs === 'object') {
      this.seqs = new Map(Object.entries(data.seqs).filter(([, v]) => typeof v === 'number'))
    }
    if (data.buffers && typeof data.buffers === 'object') {
      this.buffers = new Map(Object.entries(data.buffers)
        .filter(([, v]) => Array.isArray(v))
        .map(([k, v]) => [k, v.filter(e => !!e && typeof e.seq === 'number' && !!e.event).slice(-this.cap)]))
    }
  }

  subscribe(sessionId: string, fn: Listener): () => void {
    const set = this.listeners.get(sessionId) ?? new Set()
    set.add(fn); this.listeners.set(sessionId, set)
    return () => set.delete(fn)
  }

  /** Observe EVERY event across all sessions (analytics/metrics). Like subscribe, a
   *  throwing tap is isolated and never disrupts the producer or other listeners. */
  tap(fn: Listener): () => void {
    this.taps.add(fn)
    return () => this.taps.delete(fn)
  }

  emit(e: AkisEvent): void {
    const seq = (this.seqs.get(e.sessionId) ?? 0) + 1
    this.seqs.set(e.sessionId, seq)
    const buf = this.buffers.get(e.sessionId) ?? []
    buf.push({ seq, event: e })
    if (buf.length > this.cap) buf.splice(0, buf.length - this.cap)
    // Re-insert (delete first) so this session moves to the MOST-RECENT slot in Map order — the LRU
    // touch. Then bound the number of retained session buffers: over the cap, drop the OLDEST
    // session's buffer (keep its seq high-water mark so replaySince still reports dropped:true).
    this.buffers.delete(e.sessionId)
    this.buffers.set(e.sessionId, buf)
    while (this.buffers.size > this.maxSessions) {
      const oldest = this.buffers.keys().next().value
      if (oldest === undefined) break
      this.buffers.delete(oldest) // seqs[oldest] intentionally retained (truthful head + dropped detection)
    }
    // A broken subscriber (e.g. an SSE write to a dead socket) must NOT stop the
    // other listeners for this event, nor throw back into the producer that
    // emitted it. Cleanup is the subscriber's own responsibility.
    this.listeners.get(e.sessionId)?.forEach(fn => {
      try { fn(e, seq) } catch { /* isolate a faulty listener */ }
    })
    this.taps.forEach(fn => {
      try { fn(e, seq) } catch { /* isolate a faulty tap */ }
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

  /** Active listener count for a session — observability + leak detection in tests. */
  listenerCount(sessionId: string): number {
    return this.listeners.get(sessionId)?.size ?? 0
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
    // `dropped` = the requested range is no longer fully replayable, so the client must re-sync
    // from session state instead of trusting this (partial) log. TWO causes, both detected here:
    //  (a) OVERFLOW — the buffer is non-empty but its oldest seq is past afterSeq+1.
    //  (b) LRU EVICTION — the buffer is GONE (absent) yet the seq high-water mark shows events DID
    //      exist beyond afterSeq. Without this second clause an evicted buffer reported dropped:false
    //      (a silent lie: empty log read as a clean full history), and the reset→/log→getSession
    //      re-sync safety net never fired (the HIGH lifecycle finding).
    const head = this.seqs.get(sessionId) ?? 0
    const evicted = oldest === undefined && head > afterSeq
    const dropped = (oldest !== undefined && afterSeq + 1 < oldest) || evicted
    return { dropped, events }
  }
}
