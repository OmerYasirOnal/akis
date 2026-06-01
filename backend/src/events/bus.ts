import type { AkisEvent } from '@akis/shared'

type Listener = (e: AkisEvent) => void

export class EventBus {
  private listeners = new Map<string, Set<Listener>>()
  private buffers = new Map<string, AkisEvent[]>()
  constructor(private readonly cap = 200) {}

  subscribe(sessionId: string, fn: Listener): () => void {
    const set = this.listeners.get(sessionId) ?? new Set()
    set.add(fn); this.listeners.set(sessionId, set)
    return () => set.delete(fn)
  }

  emit(e: AkisEvent): void {
    const buf = this.buffers.get(e.sessionId) ?? []
    buf.push(e)
    if (buf.length > this.cap) buf.splice(0, buf.length - this.cap)
    this.buffers.set(e.sessionId, buf)
    this.listeners.get(e.sessionId)?.forEach(fn => fn(e))
  }

  recent(sessionId: string): AkisEvent[] {
    return [...(this.buffers.get(sessionId) ?? [])]
  }
}
