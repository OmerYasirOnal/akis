import type { AkisEvent } from '@akis/shared'

/** Minimal EventSource surface we depend on (so it's mockable in tests). `readyState`
 *  follows the EventSource spec: 0 CONNECTING, 1 OPEN, 2 CLOSED. */
export interface EventSourceLike {
  onmessage: ((ev: { data: string; lastEventId: string }) => void) | null
  onopen: ((ev: unknown) => void) | null
  onerror: ((ev: unknown) => void) | null
  readonly readyState: number
  addEventListener(type: string, fn: (ev: { data: string }) => void): void
  close(): void
}
export type EventSourceFactory = (url: string) => EventSourceLike

export interface ConnectHandlers {
  onEvent: (e: AkisEvent, seq: number) => void
  onReset?: (data: { head: number }) => void
  /** Called on a transport error. `closed` is true when the EventSource is CLOSED and will
   *  NOT auto-retry (e.g. a non-retriable 404) — the consumer must reconnect manually. */
  onError?: (info: { closed: boolean }) => void
  /** Called when the connection OPENS. Lets the consumer clear a "reconnecting" banner even at a
   *  QUIESCENT session (a parked approval gate) where no event/reset follows the resume. */
  onOpen?: () => void
}

/**
 * Resumable SSE consumer for the orchestrator live stream (sub-project 2 / F2-AC12).
 * The browser's EventSource auto-resumes via `Last-Event-ID` on reconnect, so this
 * client just parses frames, tracks the last seq, and surfaces the `reset` control
 * event (on which the view refetches GET /sessions/:id and resumes from head — no
 * lost/duplicated steps). The EventSource is injected so it's testable without a DOM.
 */
export class EventStreamClient {
  lastSeq = 0
  private es: EventSourceLike | undefined
  constructor(private factory: EventSourceFactory = defaultFactory) {}

  connect(url: string, handlers: ConnectHandlers): void {
    const es = this.factory(url)
    this.es = es
    es.onmessage = msg => {
      const seq = Number.parseInt(msg.lastEventId, 10)
      if (Number.isFinite(seq) && seq > this.lastSeq) this.lastSeq = seq
      const event = parse(msg.data)
      if (event) handlers.onEvent(event, Number.isFinite(seq) ? seq : this.lastSeq)
    }
    es.addEventListener('reset', e => {
      const data = parseReset(e.data)
      if (data && handlers.onReset) handlers.onReset(data)
    })
    // EventSource fires onerror on BOTH transient drops (readyState CONNECTING — it auto-retries
    // via Last-Event-ID) and permanent failures (readyState CLOSED — it gives up). Surface which,
    // so the consumer can manually reconnect a CLOSED stream instead of "reconnecting" forever.
    if (handlers.onOpen) es.onopen = () => handlers.onOpen?.()
    if (handlers.onError) es.onerror = () => handlers.onError?.({ closed: es.readyState === 2 })
  }

  close(): void {
    this.es?.close()
    this.es = undefined
  }
}

function parse(data: string): AkisEvent | null {
  try {
    const o = JSON.parse(data) as unknown
    if (o && typeof o === 'object' && 'kind' in o) return o as AkisEvent
  } catch { /* ignore malformed frame */ }
  return null
}

function parseReset(data: string): { head: number } | null {
  try {
    const o = JSON.parse(data) as { head?: unknown }
    if (typeof o.head === 'number') return { head: o.head }
  } catch { /* ignore */ }
  return null
}

const defaultFactory: EventSourceFactory = url => new EventSource(url) as unknown as EventSourceLike
