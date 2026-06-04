import { randomUUID } from 'node:crypto'

export interface AuthUser { id: string; name: string; email: string; passwordHash: string; createdAt: string; externalId?: string }
/** The user projection safe to return over the wire — never includes the hash. */
export interface PublicUser { id: string; name: string; email: string }
export const toPublic = (u: AuthUser): PublicUser => ({ id: u.id, name: u.name, email: u.email })

export class EmailTakenError extends Error { constructor() { super('email already registered'); this.name = 'EmailTakenError' } }

/** The persistence seam used by the auth/oauth routes — implemented by the in-memory
 *  UserStore and the Postgres-backed PgUserStore. */
export interface UserStorePort {
  create(input: { name: string; email: string; passwordHash: string }): Promise<AuthUser>
  findByEmail(email: string): Promise<AuthUser | undefined>
  findById(id: string): Promise<AuthUser | undefined>
  updatePassword(id: string, passwordHash: string): Promise<void>
  updateName(id: string, name: string): Promise<AuthUser | undefined>
  upsertOAuth(input: { externalId: string; email: string; name: string }): Promise<AuthUser>
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
  async upsertOAuth(input: { externalId: string; email: string; name: string }): Promise<AuthUser> {
    const byExt = this.byExternalId.get(input.externalId)
    if (byExt) return byExt
    const email = input.email.trim().toLowerCase()
    const existing = this.byEmail.get(email)
    if (existing) { // link this provider identity to the verified-email account
      if (!existing.externalId) { existing.externalId = input.externalId; this.byExternalId.set(input.externalId, existing) }
      return existing
    }
    const u: AuthUser = { id: this.genId(), name: input.name.trim() || email, email, passwordHash: '', createdAt: this.clock(), externalId: input.externalId }
    this.byEmail.set(email, u); this.byId.set(u.id, u); this.byExternalId.set(input.externalId, u)
    return u
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
    }
  }
}
