import { randomUUID } from 'node:crypto'
import { type AuthUser, type UserStorePort, EmailTakenError } from './UserStore.js'
import { type SqlClient, createPgPool, runMigrations } from '../store/pg.js'

/** Re-exported from the shared Pg seam (store/pg.ts) for backward compatibility —
 *  callers and tests that import `SqlClient` from here keep working. */
export type { SqlClient }

interface Row { id: string; name: string; email: string; password_hash: string; created_at: string | Date; external_id?: string | null; token_version?: number | string | null }
const toUser = (r: Row): AuthUser => ({
  id: r.id, name: r.name, email: r.email, passwordHash: r.password_hash,
  createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  ...(r.external_id ? { externalId: r.external_id } : {}),
  ...(r.token_version !== null && r.token_version !== undefined ? { tokenVersion: Number(r.token_version) } : {}),
})
const norm = (e: string): string => e.trim().toLowerCase()
const PG_UNIQUE_VIOLATION = '23505'

/**
 * Postgres-backed user store (the DB seam behind UserStorePort). Email is the unique
 * key (lowercased). Pure SQL over an injected SqlClient — unit-testable with a fake
 * client and drop-in for a real `pg` Pool. Selected when DATABASE_URL is configured.
 */
export class PgUserStore implements UserStorePort {
  constructor(private db: SqlClient, private genId: () => string = randomUUID) {}

  async create(input: { name: string; email: string; passwordHash: string }): Promise<AuthUser> {
    const id = this.genId(), email = norm(input.email)
    try {
      const { rows } = await this.db.query(
        'INSERT INTO users (id, name, email, password_hash) VALUES ($1,$2,$3,$4) RETURNING *',
        [id, input.name.trim(), email, input.passwordHash],
      )
      return toUser(rows[0] as unknown as Row)
    } catch (err) {
      if ((err as { code?: string }).code === PG_UNIQUE_VIOLATION) throw new EmailTakenError()
      throw err
    }
  }

  async findByEmail(email: string): Promise<AuthUser | undefined> {
    const { rows } = await this.db.query('SELECT * FROM users WHERE email = $1', [norm(email)])
    return rows[0] ? toUser(rows[0] as unknown as Row) : undefined
  }

  async findById(id: string): Promise<AuthUser | undefined> {
    const { rows } = await this.db.query('SELECT * FROM users WHERE id = $1', [id])
    return rows[0] ? toUser(rows[0] as unknown as Row) : undefined
  }

  async updatePassword(id: string, passwordHash: string): Promise<void> {
    await this.db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, id])
  }

  async bumpTokenVersion(id: string): Promise<void> {
    await this.db.query('UPDATE users SET token_version = COALESCE(token_version, 0) + 1 WHERE id = $1', [id])
  }

  async updateName(id: string, name: string): Promise<AuthUser | undefined> {
    const { rows } = await this.db.query('UPDATE users SET name = $1 WHERE id = $2 RETURNING *', [name.trim(), id])
    return rows[0] ? toUser(rows[0] as unknown as Row) : undefined
  }

  async upsertOAuth(input: { externalId: string; email: string; name: string }): Promise<AuthUser> {
    // 1) same provider identity returning?
    const byExt = await this.db.query('SELECT * FROM users WHERE external_id = $1', [input.externalId])
    if (byExt.rows[0]) return toUser(byExt.rows[0] as unknown as Row)
    const email = norm(input.email)
    // 2) link to the (provider-verified) email account, recording the identity.
    const byEmail = await this.findByEmail(email)
    if (byEmail) {
      // Link this provider identity to the verified-email account ONLY if it isn't
      // already bound. If it already carries a (different) identity, do NOT clobber it
      // and return it UNCHANGED — mirroring the in-memory store, which returns `existing`
      // with its original externalId rather than a fabricated one that was never persisted.
      if (byEmail.externalId) return byEmail
      await this.db.query('UPDATE users SET external_id = $1 WHERE id = $2', [input.externalId, byEmail.id])
      return { ...byEmail, externalId: input.externalId }
    }
    // 3) create — race-safe: a concurrent first login may insert the same email/identity.
    try {
      const { rows } = await this.db.query(
        'INSERT INTO users (id, name, email, password_hash, external_id) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [this.genId(), input.name.trim() || email, email, '', input.externalId],
      )
      return toUser(rows[0] as unknown as Row)
    } catch (err) {
      if ((err as { code?: string }).code === PG_UNIQUE_VIOLATION) {
        const raced = (await this.db.query('SELECT * FROM users WHERE external_id = $1 OR email = $2', [input.externalId, email])).rows[0]
        if (raced) return toUser(raced as unknown as Row)
      }
      throw err
    }
  }
}

/** Wrap an already-built SqlClient (the shared pool) in a PgUserStore. Used by the DI
 *  container so users + sessions + workflows all share ONE pool whose schema was
 *  migrated once via runMigrations — no second pool, no re-running migrations here. */
export function createPgUserStoreWithClient(db: SqlClient): PgUserStore {
  return new PgUserStore(db)
}

/**
 * Build a PgUserStore from a connection string: lazily create the shared pool (only a
 * runtime requirement when DATABASE_URL is set), ensure the schema via runMigrations,
 * and return the store. Throws a clear error if `pg` isn't installed.
 */
export async function createPgUserStore(connectionString: string): Promise<PgUserStore> {
  const pool = await createPgPool(connectionString)
  await runMigrations(pool)
  return createPgUserStoreWithClient(pool)
}
