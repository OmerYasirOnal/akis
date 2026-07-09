import type { SessionStore } from '../store/SessionStore.js'

/**
 * Per-user ACTIVE-RUN cap — the concurrency sibling of the token quota (quota.ts): a budget
 * PRE-CHECK at the WORK-STARTING boundary (route layer, before Orchestrator work begins).
 * SACRED, same contract as quota: it can only REFUSE to START work (fail-closed); it NEVER
 * weakens a gate, never touches mint/verify/push, and never reads/aborts an in-flight run.
 *
 * Why it exists: the token quota bounds SPEND per window, but not simultaneous load — a
 * within-budget user could still start N parallel builds and eat the box (LLM calls, real
 * verification boots, preview slots). This caps simultaneous pipeline-running sessions.
 */

/** Pipeline-RUNNING statuses (compute in flight: Scribe drafting / the build pipeline).
 *  Parked (push_failed/verify_failed), awaiting-gate, and terminal sessions hold no compute
 *  and never count against the cap. */
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
  store: Pick<SessionStore, 'listByOwner'>,
  policy: ConcurrencyPolicy,
  ownerId: string | undefined,
): Promise<ConcurrencyDecision> {
  if (policy.maxActiveRuns <= 0 || ownerId === undefined) {
    return { allowed: true, activeRuns: 0, limit: policy.maxActiveRuns }
  }
  const activeRuns = (await store.listByOwner(ownerId)).filter(s => ACTIVE_RUN_STATUSES.has(s.status)).length
  return { allowed: activeRuns < policy.maxActiveRuns, activeRuns, limit: policy.maxActiveRuns }
}
