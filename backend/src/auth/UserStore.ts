import { randomUUID } from 'node:crypto'

export interface AuthUser { id: string; name: string; email: string; passwordHash: string; createdAt: string }
/** The user projection safe to return over the wire — never includes the hash. */
export interface PublicUser { id: string; name: string; email: string }
export const toPublic = (u: AuthUser): PublicUser => ({ id: u.id, name: u.name, email: u.email })

export class EmailTakenError extends Error { constructor() { super('email already registered'); this.name = 'EmailTakenError' } }

/**
 * In-memory user store — the seam a DB-backed store (Postgres/Drizzle, per the platform)
 * slots behind later. Email is the unique key, normalized to lowercase. The password
 * hash is held internally and only ever leaves via `toPublic` (which drops it).
 */
export class UserStore {
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
  count(): number { return this.byId.size }
}
