import type { AkisEvent } from '@akis/shared'

/** Minimal EventSource surface we depend on (so it's mockable in tests). */
export interface EventSourceLike {
  onmessage: ((ev: { data: string; lastEventId: string }) => void) | null
  onerror: ((ev: unknown) => void) | null
  addEventListener(type: string, fn: (ev: { data: string }) => void): void
  close(): void
}
export type EventSourceFactory = (url: string) => EventSourceLike

export interface ConnectHandlers {
  onEvent: (e: AkisEvent) => void
  onReset?: (data: { head: number }) => void
  onError?: (e: unknown) => void
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
      if (event) handlers.onEvent(event)
    }
    es.addEventListener('reset', e => {
      const data = parseReset(e.data)
      if (data && handlers.onReset) handlers.onReset(data)
    })
    if (handlers.onError) es.onerror = handlers.onError
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
