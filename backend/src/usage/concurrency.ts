import type { SessionStore } from '../store/SessionStore.js'

/**
 * Per-user ACTIVE-RUN cap — the concurrency sibling of the token quota (quota.ts): a budget
 * PRE-CHECK at the WORK-STARTING boundary (route layer, before Orchestrator work begins).
 * SACRED, same contract as quota: it can only REFUSE to START work (fail-closed); it NEVER
 * weakens a gate, never touches mint/verify/push, and never reads/aborts an in-flight run.
 *
 * HONEST SCOPE (review MED): this bounds NEW-BUILD STARTS (POST /sessions + approve), not all
 * load. Recovery/push actions run compute in statuses this set deliberately does NOT count:
 * retryVerification re-runs the verifier while status stays `verify_failed`, a critic
 * 'proceed' does so under `awaiting_critic_resolution`, and confirmPush spends 5-15s of
 * network under `awaiting_push_confirm` — none are enforcement points (gating them risks
 * blocking recovery on healthy parked work; a product decision, not taken here). And like
 * checkQuota, the read-then-start window makes the cap BEST-EFFORT under simultaneous
 * starts (TOCTOU: two concurrent POSTs can both see cap-1 and both pass).
 */

/** The statuses a session occupies from a gated start until it parks/finishes: `composing`
 *  (creation + Scribe drafting — counted so a rapid burst of starts can't slip under the cap
 *  while Scribe still runs; NOTE a clarify-parked session also sits here, an accepted
 *  over-count) and `building` (the pipeline). Parked/awaiting-gate/terminal never count. */
export const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set(['composing', 'building'])

export interface ConcurrencyPolicy {
  /** Max simultaneous active runs per owner. 0 ⇒ UNLIMITED (single-operator dev default). */
  maxActiveRuns: number
}

/** Resolve from env. 0/unset/NaN/negative ⇒ unlimited, so dev/self-host is byte-unchanged. */
export function resolveConcurrencyPolicy(env: Record<string, string | undefined>): ConcurrencyPolicy {
  const raw = Number(env.AKIS_MAX_ACTIVE_RUNS)
  return { maxActiveRuns: Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 0 }
}

export interface ConcurrencyDecision { allowed: boolean; activeRuns: number; limit: number }

/**
 * Decide whether `ownerId` may START a new run under `policy`.
 * - limit 0 ⇒ unlimited, NO store read (dev fast-path, byte-identical default).
 * - anonymous (ownerId undefined) ⇒ exempt here: anonymous work has no per-owner ledger to
 *   count; a locked-down deployment governs it via AKIS_REQUIRE_AUTH_FOR_BUILDS and the anon
 *   token quota instead.
 */
export async function checkConcurrency(
  // The SUMMARY projection, not listByOwner — this count needs only `status`, and the full
  // listByOwner SELECT * ships the entire generated app (code/spec jsonb) per row (review MED).
  store: Pick<SessionStore, 'listSummariesByOwner'>,
  policy: ConcurrencyPolicy,
  ownerId: string | undefined,
): Promise<ConcurrencyDecision> {
  if (policy.maxActiveRuns <= 0 || ownerId === undefined) {
    return { allowed: true, activeRuns: 0, limit: policy.maxActiveRuns }
  }
  const activeRuns = (await store.listSummariesByOwner(ownerId)).filter(s => ACTIVE_RUN_STATUSES.has(s.status)).length
  return { allowed: activeRuns < policy.maxActiveRuns, activeRuns, limit: policy.maxActiveRuns }
}
