import { randomUUID } from 'node:crypto'

export interface AuthUser { id: string; name: string; email: string; passwordHash: string; createdAt: string }
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
  upsertOAuth(input: { email: string; name: string }): Promise<AuthUser>
}

/**
 * In-memory user store — the seam a DB-backed store (Postgres/Drizzle, per the platform)
 * slots behind later. Email is the unique key, normalized to lowercase. The password
 * hash is held internally and only ever leaves via `toPublic` (which drops it).
 */
export class UserStore implements UserStorePort {
  private byEmail = new Map<string, AuthUser>()
  private byId = new Map<string, AuthUser>()
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
  /** Find-or-create a user from an OAuth profile (no password — `passwordHash` is empty,
   *  which never verifies, so the account is OAuth-only until a reset sets a password). */
  async upsertOAuth(input: { email: string; name: string }): Promise<AuthUser> {
    const email = input.email.trim().toLowerCase()
    const existing = this.byEmail.get(email)
    if (existing) return existing
    const u: AuthUser = { id: this.genId(), name: input.name.trim() || email, email, passwordHash: '', createdAt: this.clock() }
    this.byEmail.set(email, u); this.byId.set(u.id, u)
    return u
  }
  /** Replace a user's password hash (password reset). No-op if the id is unknown. */
  async updatePassword(id: string, passwordHash: string): Promise<void> {
    const u = this.byId.get(id)
    if (u) u.passwordHash = passwordHash
  }
  count(): number { return this.byId.size }
}
