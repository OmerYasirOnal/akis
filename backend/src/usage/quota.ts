import type { UsageStorePort } from './UsageStore.js'

/**
 * Per-user token QUOTA — a budget PRE-CHECK at the WORK-STARTING boundary (the route layer,
 * before Orchestrator.start and before the chat provider call). SACRED: it can only REFUSE to
 * START work (fail-closed); it NEVER weakens a gate, never fakes verification, never touches
 * mint/verify/push, and never reads/aborts an in-flight verified run.
 */

const DAY_MS = 24 * 60 * 60 * 1000

export interface QuotaPolicy {
  /** Token budget per window. 0 ⇒ UNLIMITED (the single-operator dev default — byte-unchanged). */
  budget: number
  /** Window length in ms. */
  periodMs: number
}

/** The shared ledger row for anonymous (unauthenticated) work, so an anonymous abuser still
 *  can't drain a budgeted deployment. In dev (budget 0) anonymous work is unlimited via the
 *  fast-path (no store read). */
export const ANON_OWNER = '__anon__'

/** Parse an AKIS_USER_TOKEN_PERIOD value to ms. Named tiers + a raw `<n>d`/`<n>h` / ms number;
 *  anything unrecognized falls back to monthly. */
function parsePeriodMs(raw: string | undefined): number {
  const v = (raw ?? '').trim().toLowerCase()
  if (v === '' || v === 'monthly') return 30 * DAY_MS
  if (v === 'daily') return DAY_MS
  if (v === 'weekly') return 7 * DAY_MS
  const dm = /^(\d+)d$/.exec(v)
  if (dm) return Number(dm[1]) * DAY_MS
  const hm = /^(\d+)h$/.exec(v)
  if (hm) return Number(hm[1]) * 60 * 60 * 1000
  const ms = Number(v)
  if (Number.isFinite(ms) && ms > 0) return ms
  return 30 * DAY_MS // unrecognized ⇒ monthly
}

/** Resolve the quota policy from env. Default budget 0 (unlimited) so single-operator dev is
 *  BYTE-UNCHANGED. AKIS_USER_TOKEN_BUDGET: integer tokens (0/unset/NaN ⇒ unlimited). */
/** The two account tiers. 'free' is the default (server-managed key + AKIS_USER_TOKEN_BUDGET);
 *  'pro' is the paid subscription (AKIS_PRO_TOKEN_BUDGET, default 0 ⇒ unlimited). */
export type Tier = 'free' | 'pro'

export function resolveQuotaPolicy(env: Record<string, string | undefined>, tier: Tier = 'free'): QuotaPolicy {
  // TIER-AWARE: pro reads AKIS_PRO_TOKEN_BUDGET, free reads AKIS_USER_TOKEN_BUDGET. Default tier='free'
  // keeps every existing caller byte-UNCHANGED (and a deployment that never sets the pro var). 0/unset/
  // NaN ⇒ unlimited for that tier.
  const raw = Number(tier === 'pro' ? env.AKIS_PRO_TOKEN_BUDGET : env.AKIS_USER_TOKEN_BUDGET)
  const budget = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 0
  return { budget, periodMs: parsePeriodMs(env.AKIS_USER_TOKEN_PERIOD) }
}

export interface QuotaDecision {
  allowed: boolean
  usedTokens: number
  budget: number
  /** Tokens remaining in the window. `-1` is the sentinel for UNLIMITED (budget 0). */
  remaining: number
  /** ISO when the current window resets. Empty string when unlimited. */
  resetAt: string
}

/** A typed error mapped to 429 {error, code:'QuotaExceeded', resetAt} at the route layer. */
export class QuotaExceededError extends Error {
  constructor(readonly resetAt: string) {
    super('token quota exceeded')
    this.name = 'QuotaExceededError'
  }
}

/**
 * Decide whether `ownerId` may START new work under `policy`.
 *
 * - budget 0 ⇒ UNLIMITED: allowed, remaining -1, NO store read (byte-identical default path).
 * - ownerId undefined (anonymous) ⇒ governed by the shared {@link ANON_OWNER} ledger row when a
 *   budget is set (in dev budget 0 ⇒ unlimited via the fast-path above, no store read).
 * - else read the owner's window: allowed = (budget - periodTokens) > 0.
 */
export async function checkQuota(
  store: UsageStorePort,
  policy: QuotaPolicy,
  ownerId: string | undefined,
  now?: number,
): Promise<QuotaDecision> {
  if (policy.budget <= 0) {
    // Unlimited: no store read, no allocation — the single-operator dev default is unchanged.
    return { allowed: true, usedTokens: 0, budget: 0, remaining: -1, resetAt: '' }
  }
  const key = ownerId ?? ANON_OWNER
  const rec = await store.get(key, now)
  const remaining = policy.budget - rec.periodTokens
  const resetAt = new Date(new Date(rec.windowStart).getTime() + policy.periodMs).toISOString()
  return {
    allowed: remaining > 0,
    usedTokens: rec.periodTokens,
    budget: policy.budget,
    remaining: Math.max(0, remaining),
    resetAt,
  }
}
