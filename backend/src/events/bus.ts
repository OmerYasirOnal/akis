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
  private buffers = new Map<string, SeqEvent[]>()
  private seqs = new Map<string, number>()
  /** Pending graced evictions per session — armed on a terminal event, cancelled by ANY new
   *  event for that session (a retry/iterate revives it). See emit(). */
  private evictions = new Map<string, NodeJS.Timeout>()
  constructor(private readonly cap = 200, private readonly evictAfterMs = 60_000) {}

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
    // A pending eviction is cancelled by ANY new event — a retry/iterate revived the session,
    // so its replay buffer must stay live (the timer re-arms only on the next terminal event).
    const pending = this.evictions.get(e.sessionId)
    if (pending) { clearTimeout(pending); this.evictions.delete(e.sessionId) }
    const seq = (this.seqs.get(e.sessionId) ?? 0) + 1
    this.seqs.set(e.sessionId, seq)
    const buf = this.buffers.get(e.sessionId) ?? []
    buf.push({ seq, event: e })
    if (buf.length > this.cap) buf.splice(0, buf.length - this.cap)
    this.buffers.set(e.sessionId, buf)
    // MEMORY (audit quick-win): buffers/seqs used to stay resident for the PROCESS LIFETIME —
    // every build that ever ran kept its buffer forever. On the same terminal events the
    // UsageCollector already prunes on (`done`, session failed/done/cancelled), arm a GRACED
    // eviction: the grace lets the final /log replay + SSE drain finish, and replaySince
    // already reports `dropped` for an evicted buffer (the client re-syncs from session state),
    // so a late reader degrades exactly like an overflow. unref() keeps the timer from
    // holding the process open.
    if (e.kind === 'done' || (e.kind === 'session' && e.status !== 'started')) {
      const timer = setTimeout(() => {
        this.evictions.delete(e.sessionId)
        this.buffers.delete(e.sessionId)
        this.seqs.delete(e.sessionId)
      }, this.evictAfterMs)
      timer.unref?.()
      this.evictions.set(e.sessionId, timer)
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
    const dropped = oldest !== undefined && afterSeq + 1 < oldest
    return { dropped, events }
  }
}
