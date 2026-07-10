/**
 * Human ADMIN identity — env-allowlist based, consistent with AKIS's env-driven config (and with
 * the existing single-user `AKIS_OWNER_EMAIL`). A user is an admin iff their email is in
 * `AKIS_ADMIN_EMAILS` (comma-separated) OR equals `AKIS_OWNER_EMAIL` (the single owner is always
 * an admin). No DB migration, no first-user-is-admin race, works keyless/self-host.
 *
 * Derived at READ time from env — never persisted into the session token. So granting/revoking
 * admin is an env change that takes effect immediately (a stale token can't carry stale admin).
 *
 * OPT-IN, byte-identical default: with NO allowlist configured, `configured` is false and callers
 * fall back to their prior behavior (e.g. `/api/ops` stays any-authenticated for single-operator
 * dev/self-host). A MULTI-USER deployment SHOULD set `AKIS_ADMIN_EMAILS` to restrict admin-only
 * surfaces — until it does, `isAdminEmail` returns false for everyone (never accidentally all-admin).
 */
export interface AdminPolicy {
  /** Normalized (trimmed, lowercased) admin emails. */
  emails: ReadonlySet<string>
  /** True iff at least one admin email is configured. */
  configured: boolean
}

/** The outcome of an admin-gated access check. `unauthenticated` → 401 (not logged in);
 *  `forbidden` → 403 (logged in but not an admin — NEVER 401, or the FE would log the user out). */
export type AccessCheck = 'ok' | 'unauthenticated' | 'forbidden'

export function resolveAdminPolicy(env: Record<string, string | undefined>): AdminPolicy {
  const emails = new Set<string>()
  const add = (raw: string | undefined): void => {
    for (const part of (raw ?? '').split(',')) {
      const e = part.trim().toLowerCase()
      if (e) emails.add(e)
    }
  }
  add(env.AKIS_ADMIN_EMAILS)
  add(env.AKIS_OWNER_EMAIL) // the single-owner is always an admin
  return { emails, configured: emails.size > 0 }
}

/**
 * Whether `user` is an admin under `policy`. TWO conditions, both required:
 *  1. the email is in the allowlist, AND
 *  2. the email is PROVIDER-VERIFIED — the account is OAuth-bound (`externalId` present).
 *
 * (2) closes the pre-registration escalation (gate-keeper + reviewer MED): password signup
 * verifies only email FORMAT, not ownership, so without this check an attacker could register
 * an allowlisted admin's email and become admin (and lock the real admin out via EmailTaken).
 * A password account (no `externalId`) therefore can NEVER be an admin — an admin must sign in
 * with a provider that verified the email (Google/GitHub). An UNCONFIGURED policy is never an
 * admin (fail-closed, never all-admin).
 */
export function isAdminUser(user: { email?: string; externalId?: string } | undefined, policy: AdminPolicy): boolean {
  if (!policy.configured || !user?.externalId || !user.email) return false
  return policy.emails.has(user.email.trim().toLowerCase())
}
