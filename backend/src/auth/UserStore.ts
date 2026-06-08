import { randomUUID } from 'node:crypto'
import type { Tier } from '../usage/quota.js'

export interface AuthUser { id: string; name: string; email: string; passwordHash: string; createdAt: string; externalId?: string; tokenVersion?: number; tier?: Tier; stripeCustomerId?: string; avatarUrl?: string; lastLoginProvider?: AuthProvider }

/** Which login provider an account uses — DERIVED from the externalId namespace prefix
 *  (`github:`/`google:`); a password account (no externalId) is `'password'`. Exported
 *  because both `toPublic` (the wire projection) and tests reuse it. */
export type AuthProvider = 'github' | 'google' | 'password'
export function providerOf(externalId?: string): AuthProvider {
  if (externalId?.startsWith('github:')) return 'github'
  if (externalId?.startsWith('google:')) return 'google'
  return 'password'
}

/** The user projection safe to return over the wire — never includes the hash. `provider`
 *  is the provider used for the MOST-RECENT login (so the FE badges how the user signed in
 *  THIS time, not whatever identity the account is permanently bound to) — see lastLoginProvider.
 *  `avatarUrl` is the provider picture (only present for OAuth users that exposed one). */
export interface PublicUser { id: string; name: string; email: string; provider: AuthProvider; avatarUrl?: string }
export const toPublic = (u: AuthUser): PublicUser => ({
  // Prefer the recorded last-login provider; fall back to deriving from the bound externalId for
  // rows written before lastLoginProvider existed (and for password accounts, which have neither —
  // providerOf(undefined) === 'password'). This is what keeps the badge honest when an account
  // bound to identity A signs in via identity B (same verified email): the row stays bound to A,
  // but lastLoginProvider records B, so the badge reflects THIS login.
  id: u.id, name: u.name, email: u.email, provider: u.lastLoginProvider ?? providerOf(u.externalId),
  // exactOptionalPropertyTypes: only attach avatarUrl when present (never an explicit undefined).
  ...(u.avatarUrl ? { avatarUrl: u.avatarUrl } : {}),
})

export class EmailTakenError extends Error { constructor() { super('email already registered'); this.name = 'EmailTakenError' } }

/** The persistence seam used by the auth/oauth routes — implemented by the in-memory
 *  UserStore and the Postgres-backed PgUserStore. */
export interface UserStorePort {
  create(input: { name: string; email: string; passwordHash: string }): Promise<AuthUser>
  findByEmail(email: string): Promise<AuthUser | undefined>
  findById(id: string): Promise<AuthUser | undefined>
  updatePassword(id: string, passwordHash: string): Promise<void>
  updateName(id: string, name: string): Promise<AuthUser | undefined>
  /** REVOCATION (audit gap): bump the user's token version — every outstanding session
   *  JWT (which carries the version it was signed with) stops verifying. Called on
   *  password reset and logout-all. */
  bumpTokenVersion(id: string): Promise<void>
  /** Find-or-link-or-create a user from a provider-VERIFIED OAuth profile. Steps: (1) return the
   *  user already bound to externalId; (2) else link this identity to an existing verified-email
   *  account; (3) else CREATE a new user — but ONLY when `opts.allowCreate` is not false. When
   *  creation is refused (signup-disabled) it returns `null`, so OAuth can NEVER mint a new account
   *  and bypass the no-open-signup posture (the no-sandbox RCE guard). Existing-user login/link is
   *  always allowed (the owner can sign in via OAuth). Default allowCreate=true (signup-enabled). */
  upsertOAuth(input: { externalId: string; email: string; name: string; avatarUrl?: string }, opts?: { allowCreate?: boolean }): Promise<AuthUser | null>
  /** Set the user's billing tier + Stripe customer id (the paid-tier webhook). Additive; absent fields
   *  are left unchanged. Returns the updated user (or undefined if unknown). */
  setSubscription(id: string, patch: { tier?: Tier; stripeCustomerId?: string }): Promise<AuthUser | undefined>
  /** Map a Stripe customer id back to the user — for subscription.updated/deleted webhook events that
   *  carry only the customer, not our userId. Undefined if no user is bound to that customer. */
  findByStripeCustomerId(customerId: string): Promise<AuthUser | undefined>
}

/**
 * In-memory user store — the seam a DB-backed store (Postgres/Drizzle, per the platform)
 * slots behind later. Email is the unique key, normalized to lowercase. The password
 * hash is held internally and only ever leaves via `toPublic` (which drops it).
 */
export class UserStore implements UserStorePort {
  private byEmail = new Map<string, AuthUser>()
  private byId = new Map<string, AuthUser>()
  private byExternalId = new Map<string, AuthUser>()
  private byStripeCustomerId = new Map<string, AuthUser>()
  constructor(private genId: () => string = randomUUID, private clock: () => string = () => new Date().toISOString()) {}

  async create(input: { name: string; email: string; passwordHash: string }): Promise<AuthUser> {
    const email = input.email.trim().toLowerCase()
    if (this.byEmail.has(email)) throw new EmailTakenError()
    const u: AuthUser = { id: this.genId(), name: input.name.trim(), email, passwordHash: input.passwordHash, createdAt: this.clock() }
    this.byEmail.set(email, u)
    this.byId.set(u.id, u)
    return u
  }
  async findByEmail(email: string): Promise<AuthUser | undefined> { return this.byEmail.get(email.trim().toLowerCase()) }
  async findById(id: string): Promise<AuthUser | undefined> { return this.byId.get(id) }
  /** Find-or-create a user from an OAuth profile. Bound to the provider identity
   *  (externalId) first; falls back to the (provider-VERIFIED) email, linking it to that
   *  identity. New OAuth users have an empty passwordHash (never verifies). The caller
   *  MUST have verified the email with the provider before linking by email. */
  async upsertOAuth(input: { externalId: string; email: string; name: string; avatarUrl?: string }, opts?: { allowCreate?: boolean }): Promise<AuthUser | null> {
    const provider = providerOf(input.externalId)
    const byExt = this.byExternalId.get(input.externalId)
    if (byExt) {
      // Returning identity: REFRESH the avatar so an owner who logged in before this feature
      // finally gets their photo. Update only when the profile carries a new avatar; otherwise
      // preserve whatever the account already had (mirrors the Pg COALESCE($new, avatar_url)).
      // Guarded assignment so an absent avatar never writes an explicit undefined over the
      // optional field (exactOptionalPropertyTypes). (The in-memory AuthUser has no
      // status/email_verified, so avatar is all that applies.)
      if (input.avatarUrl) byExt.avatarUrl = input.avatarUrl
      byExt.lastLoginProvider = provider // record the provider used THIS login (badge source of truth)
      return byExt
    }
    const email = input.email.trim().toLowerCase()
    const existing = this.byEmail.get(email)
    if (existing) {
      // record the provider used THIS login FIRST, so it lands on EVERY existing-account path —
      // the fresh link AND the already-bound-to-a-different-identity case — keeping the badge honest
      // about how the user signed in NOW even though the bound identity (externalId) never moves.
      existing.lastLoginProvider = provider
      if (existing.externalId) {
        // ALREADY bound to a DIFFERENT identity (parity with Pg `if (byEmail.externalId)`): do NOT
        // rebind externalId — that identity is permanent and was never persisted under the new
        // namespace. But DO refresh the avatar when the current login carries one, so the badge AND
        // the photo both reflect the provider just used. Guard so an absent avatar never writes an
        // explicit undefined over the optional field (exactOptionalPropertyTypes).
        if (input.avatarUrl) existing.avatarUrl = input.avatarUrl
        return existing
      }
      // FRESH link (no externalId yet): bind this provider identity to the verified-email account.
      existing.externalId = input.externalId
      this.byExternalId.set(input.externalId, existing)
      // Adopt the provider avatar only when the account has none yet (don't clobber a picture the
      // user already had) — mirrors the Pg COALESCE(avatar_url, $2) link path. Guard the assignment
      // so a missing avatar never writes an explicit undefined over the optional field.
      if (!existing.avatarUrl && input.avatarUrl) existing.avatarUrl = input.avatarUrl
      return existing
    }
    // Step 3 (create) — REFUSED when signup is disabled: OAuth must not mint a new account.
    if (opts?.allowCreate === false) return null
    const u: AuthUser = { id: this.genId(), name: input.name.trim() || email, email, passwordHash: '', createdAt: this.clock(), externalId: input.externalId, lastLoginProvider: provider, ...(input.avatarUrl ? { avatarUrl: input.avatarUrl } : {}) }
    this.byEmail.set(email, u); this.byId.set(u.id, u); this.byExternalId.set(input.externalId, u)
    return u
  }
  async bumpTokenVersion(id: string): Promise<void> {
    const u = this.byId.get(id)
    if (u) u.tokenVersion = (u.tokenVersion ?? 0) + 1
  }
  /** Replace a user's password hash (password reset). No-op if the id is unknown. */
  async updatePassword(id: string, passwordHash: string): Promise<void> {
    const u = this.byId.get(id)
    if (u) u.passwordHash = passwordHash
  }
  /** Update a user's display name; returns the updated user (or undefined if unknown). */
  async updateName(id: string, name: string): Promise<AuthUser | undefined> {
    const u = this.byId.get(id)
    if (u) u.name = name.trim()
    return u
  }
  async setSubscription(id: string, patch: { tier?: Tier; stripeCustomerId?: string }): Promise<AuthUser | undefined> {
    const u = this.byId.get(id)
    if (!u) return undefined
    if (patch.tier !== undefined) u.tier = patch.tier
    if (patch.stripeCustomerId !== undefined) { u.stripeCustomerId = patch.stripeCustomerId; this.byStripeCustomerId.set(patch.stripeCustomerId, u) }
    return u
  }
  async findByStripeCustomerId(customerId: string): Promise<AuthUser | undefined> { return this.byStripeCustomerId.get(customerId) }
  count(): number { return this.byId.size }

  /** Snapshot every user (data only — for the dev-persistence wrapper's save). */
  snapshot(): AuthUser[] { return [...this.byId.values()] }
  /** Bulk-load users (data only — for the dev-persistence wrapper's boot hydrate).
   *  Rebuilds all three indexes; a later duplicate of an email/id simply overwrites. */
  hydrate(users: AuthUser[]): void {
    for (const u of users) {
      this.byEmail.set(u.email, u)
      this.byId.set(u.id, u)
      if (u.externalId) this.byExternalId.set(u.externalId, u)
      if (u.stripeCustomerId) this.byStripeCustomerId.set(u.stripeCustomerId, u)
    }
  }
}
