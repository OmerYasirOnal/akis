import type { AkisEvent } from '@akis/shared'
import type { EventBus } from '../events/bus.js'
import type { UsageStorePort } from './UsageStore.js'

/**
 * The CENTRALIZED, honest per-user usage accounting via a single global bus tap (mirrors
 * StatsCollector). It maps sessionId→ownerId on `session/started` (the additive ownerId field)
 * and, on every `agent_end` carrying a REAL `metrics.usage`, accumulates (in+out) tokens to that
 * owner via {@link UsageStorePort}.add — the SYNCHRONOUS, self-contained path (no async store.get
 * inside the tap, which would race with cancel).
 *
 * Honesty: absent/zero usage ⇒ no add (counts 0, never fabricated — exactly the {0,0}→absent
 * rule buildAgentMetrics already enforces upstream). An unmapped/anonymous session ⇒ skipped,
 * never misattributed. The owner map is pruned on the terminal `session` (done/failed/cancelled)
 * so it stays bounded; a late agent_end after terminal is simply not attributed (never to the
 * wrong owner).
 *
 * Chat usage is OFF the bus (the chat route calls the provider directly, never emits agent_end),
 * so it is accounted DIRECTLY by the chat route via the SAME UsageStorePort.add — zero overlap
 * with this tap.
 */
export class UsageCollector {
  private owners = new Map<string, string>() // sessionId → ownerId
  constructor(private store: UsageStorePort) {}

  /** Attach to a bus; returns the unsubscribe handle (a throwing tap is isolated by bus.tap). */
  attach(bus: EventBus): () => void { return bus.tap(e => this.observe(e)) }

  observe(e: AkisEvent): void {
    if (e.kind === 'session') {
      if (e.status === 'started') {
        if (e.ownerId) this.owners.set(e.sessionId, e.ownerId)
      } else {
        // terminal (done/failed/cancelled) — prune so the map stays bounded.
        this.owners.delete(e.sessionId)
      }
      return
    }
    if (e.kind === 'agent_end' && e.metrics?.usage) {
      const owner = this.owners.get(e.sessionId)
      const tok = e.metrics.usage.inTokens + e.metrics.usage.outTokens
      // Anonymous/unmapped ⇒ skip (never misattributed). {0,0} ⇒ no add (honest absent).
      if (owner && tok > 0) {
        // Fire-and-forget: the in-memory path never throws; the Pg path swallow-logs. Catch the
        // promise so a rejected store.add never becomes an unhandled rejection.
        void Promise.resolve(this.store.add(owner, tok)).catch(() => { /* accounting is best-effort observability */ })
      }
    }
  }
}
