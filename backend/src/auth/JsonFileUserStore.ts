import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { UserStore, type UserStorePort, type AuthUser } from './UserStore.js'

/**
 * DEV-ONLY file-persisted user store: the in-memory {@link UserStore} plus a JSON file
 * (~/.akis/dev-users.json, 0600) saved on every mutation and loaded on boot — so editing
 * backend code (which restarts tsx-watch and wipes process memory) NO LONGER DELETES
 * ACCOUNTS. This was the real cause of "my signups keep disappearing" in dev: nothing
 * was deleting them; they only ever lived in RAM.
 *
 * Scope and honesty:
 *  - DEV ONLY. Production uses Postgres (PgUserStore) when DATABASE_URL is set, and
 *    production without a DB already fails closed elsewhere — this store is selected
 *    only on the non-production, non-test default path (see server.ts).
 *  - The file holds what the in-memory store holds: scrypt PASSWORD HASHES, never
 *    plaintext. 0600 like the dev secret. Still: dev convenience, not a database.
 *  - Persistence is BEST-EFFORT (an unwritable disk degrades to in-memory with a
 *    warning, never a crash) — but reads/writes are synchronous, so a successful save
 *    means the file is current before the request returns.
 */
export class JsonFileUserStore implements UserStorePort {
  private inner = new UserStore()
  private warned = false

  constructor(private file = join(homedir(), '.akis', 'dev-users.json')) {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      if (Array.isArray(raw)) {
        // Tolerant hydrate: keep only rows that look like users (a hand-edited or
        // corrupted file never crashes the boot — bad rows are simply dropped).
        const users = raw.filter((u): u is AuthUser =>
          !!u && typeof u === 'object'
          && typeof (u as AuthUser).id === 'string'
          && typeof (u as AuthUser).email === 'string'
          && typeof (u as AuthUser).passwordHash === 'string')
        this.inner.hydrate(users)
      }
    } catch { /* first boot (no file yet) or unreadable — start empty */ }
  }

  /** Save the full snapshot (0600). Best-effort: a write failure warns once and the
   *  store keeps working in-memory — never a crash, never a half-written lock-up. */
  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(this.inner.snapshot(), null, 2), { mode: 0o600 })
      chmodSync(this.file, 0o600) // mode above is masked by umask — chmod makes 0600 unconditional (final review)
    } catch {
      if (!this.warned) {
        this.warned = true
        // eslint-disable-next-line no-console
        console.warn('auth: dev-users file unwritable — accounts will reset on restart (in-memory only)')
      }
    }
  }

  async create(input: { name: string; email: string; passwordHash: string }): Promise<AuthUser> {
    const u = await this.inner.create(input)
    this.persist()
    return u
  }
  async findByEmail(email: string): Promise<AuthUser | undefined> { return this.inner.findByEmail(email) }
  async findById(id: string): Promise<AuthUser | undefined> { return this.inner.findById(id) }
  async bumpTokenVersion(id: string): Promise<void> {
    await this.inner.bumpTokenVersion(id)
    this.persist()
  }
  async updatePassword(id: string, passwordHash: string): Promise<void> {
    await this.inner.updatePassword(id, passwordHash)
    this.persist()
  }
  async updateName(id: string, name: string): Promise<AuthUser | undefined> {
    const u = await this.inner.updateName(id, name)
    this.persist()
    return u
  }
  async upsertOAuth(input: { externalId: string; email: string; name: string }, opts?: { allowCreate?: boolean }): Promise<AuthUser | null> {
    const u = await this.inner.upsertOAuth(input, opts)
    if (u) this.persist() // a refused create (null) changed nothing — don't rewrite the file
    return u
  }
  async setSubscription(id: string, patch: { tier?: import('../usage/quota.js').Tier; stripeCustomerId?: string }): Promise<AuthUser | undefined> {
    const u = await this.inner.setSubscription(id, patch)
    if (u) this.persist()
    return u
  }
  async findByStripeCustomerId(customerId: string): Promise<AuthUser | undefined> { return this.inner.findByStripeCustomerId(customerId) }
}
