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

/** Whether `email` is an admin under `policy`. An UNCONFIGURED policy is never an admin (so a
 *  deployment that forgot to set the allowlist is fail-closed for explicit admin, not all-admin). */
export function isAdminEmail(email: string | undefined, policy: AdminPolicy): boolean {
  if (!policy.configured || !email) return false
  return policy.emails.has(email.trim().toLowerCase())
}
