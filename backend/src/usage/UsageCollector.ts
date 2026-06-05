import type { AkisEvent } from '@akis/shared'
import type { EventBus } from '../events/bus.js'
import type { UsageStorePort } from './UsageStore.js'
import { ANON_OWNER } from './quota.js'

/**
 * The CENTRALIZED, honest per-user usage accounting via a single global bus tap (mirrors
 * StatsCollector). It maps sessionId→ownerId on `session/started` and, on every `agent_end`
 * carrying a REAL `metrics.usage`, accumulates (in+out) tokens to that owner via
 * {@link UsageStorePort}.add — the SYNCHRONOUS, self-contained path (no async store.get inside
 * the tap, which would race with cancel).
 *
 * ANONYMOUS BUILDS (no ownerId on `started`) map to the shared {@link ANON_OWNER} ledger row, so
 * the COSTLIEST anonymous operation — a whole-app Proto generation in a budgeted deployment — is
 * metered to `__anon__` (mirroring the chat route's `ownerId ?? ANON_OWNER`). Without this, an
 * anonymous build's spend was added to NO ledger and could never trip the `__anon__` 429,
 * defeating the multi-tenant guard precisely on the build path. A TRULY UNMAPPED session (an
 * `agent_end` with no preceding `started`) still has NO map entry ⇒ skipped, never misattributed.
 *
 * Honesty: absent/zero usage ⇒ no add (counts 0, never fabricated — exactly the {0,0}→absent
 * rule buildAgentMetrics already enforces upstream).
 *
 * PRUNING — the map is bounded over process lifetime. It is pruned on EVERY terminal signal a run
 * can end with: a terminal `session` event (status failed/cancelled — Orchestrator.cancel / the
 * failed-throw path) AND the `done` event (the SUCCESSFUL-completion signal). A successful build
 * does NOT emit `session/done`; it persists `store.update(…, {status:'done'})` and emits a
 * SEPARATE `kind:'done'`, so pruning ONLY on `session` would leak the entry on every successful
 * build (slow unbounded growth). A late agent_end after pruning has no mapping ⇒ skipped (never
 * attributed to the wrong owner).
 *
 * Chat usage is OFF the bus (the chat route calls the provider directly, never emits agent_end),
 * so it is accounted DIRECTLY by the chat route via the SAME UsageStorePort.add — zero overlap
 * with this tap.
 */
export class UsageCollector {
  private owners = new Map<string, string>() // sessionId → ownerId (ANON_OWNER for anonymous)
  constructor(private store: UsageStorePort) {}

  /** Attach to a bus; returns the unsubscribe handle (a throwing tap is isolated by bus.tap). */
  attach(bus: EventBus): () => void { return bus.tap(e => this.observe(e)) }

  /** Live count of in-flight sessionId→owner mappings (observability; asserts the map stays
   *  bounded — every terminated run is pruned, so this returns to 0 between builds). */
  get size(): number { return this.owners.size }

  observe(e: AkisEvent): void {
    if (e.kind === 'session') {
      if (e.status === 'started') {
        // Map the run to its owner; an ANONYMOUS run (no ownerId) maps to the shared __anon__
        // ledger so its build spend is metered (and can trip the __anon__ 429), exactly like chat.
        this.owners.set(e.sessionId, e.ownerId ?? ANON_OWNER)
      } else {
        // Terminal `session` (failed/cancelled) — prune so the map stays bounded.
        this.owners.delete(e.sessionId)
      }
      return
    }
    // A SUCCESSFUL build's terminal signal is `kind:'done'` (NOT session/done). Prune here too,
    // else the owner mapping leaks on every successful build (slow unbounded growth).
    if (e.kind === 'done') {
      this.owners.delete(e.sessionId)
      return
    }
    if (e.kind === 'agent_end' && e.metrics?.usage) {
      const owner = this.owners.get(e.sessionId)
      const tok = e.metrics.usage.inTokens + e.metrics.usage.outTokens
      // Unmapped (no preceding `started`, or already pruned) ⇒ skip (never misattributed).
      // {0,0} ⇒ no add (honest absent). Anonymous maps to __anon__ above, so it IS charged.
      if (owner && tok > 0) {
        // Fire-and-forget: the in-memory path never throws; the Pg path swallow-logs. Catch the
        // promise so a rejected store.add never becomes an unhandled rejection.
        void Promise.resolve(this.store.add(owner, tok)).catch(() => { /* accounting is best-effort observability */ })
      }
    }
  }
}
