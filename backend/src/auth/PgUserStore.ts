import { randomUUID } from 'node:crypto'
import { type AuthUser, type UserStorePort, EmailTakenError } from './UserStore.js'

/** The minimal client shape PgUserStore needs — satisfied by a `pg` Pool/Client
 *  (`query(text, params) → { rows }`) and trivially faked in tests. */
export interface SqlClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>
}

interface Row { id: string; name: string; email: string; password_hash: string; created_at: string | Date; external_id?: string | null }
const toUser = (r: Row): AuthUser => ({
  id: r.id, name: r.name, email: r.email, passwordHash: r.password_hash,
  createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  ...(r.external_id ? { externalId: r.external_id } : {}),
})
const norm = (e: string): string => e.trim().toLowerCase()
const PG_UNIQUE_VIOLATION = '23505'

export const CREATE_USERS_TABLE = `
CREATE TABLE IF NOT EXISTS users (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL DEFAULT '',
  external_id   text UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now()
)`
/** Idempotent migration for pre-existing tables (added in the OAuth-identity fix). */
export const ADD_EXTERNAL_ID = `ALTER TABLE users ADD COLUMN IF NOT EXISTS external_id text`

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

  async upsertOAuth(input: { externalId: string; email: string; name: string }): Promise<AuthUser> {
    // 1) same provider identity returning?
    const byExt = await this.db.query('SELECT * FROM users WHERE external_id = $1', [input.externalId])
    if (byExt.rows[0]) return toUser(byExt.rows[0] as unknown as Row)
    const email = norm(input.email)
    // 2) link to the (provider-verified) email account, recording the identity.
    const byEmail = await this.findByEmail(email)
    if (byEmail) {
      if (!byEmail.externalId) await this.db.query('UPDATE users SET external_id = $1 WHERE id = $2', [input.externalId, byEmail.id])
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

/**
 * Build a PgUserStore from a connection string: lazily import `pg` (so it's only a
 * runtime requirement when DATABASE_URL is set), create a Pool, ensure the schema,
 * and return the store. Throws a clear error if `pg` isn't installed.
 */
export async function createPgUserStore(connectionString: string): Promise<PgUserStore> {
  let pg: { Pool: new (cfg: { connectionString: string }) => SqlClient }
  try {
    // Non-literal specifier: `pg` is an OPTIONAL runtime dependency, so tsc must not
    // try to resolve it at build time (it's only needed when DATABASE_URL is set).
    const spec = 'pg'
    pg = (await import(spec)) as unknown as { Pool: new (cfg: { connectionString: string }) => SqlClient }
  } catch {
    throw new Error('DATABASE_URL is set but the `pg` package is not installed (run: pnpm -C backend add pg)')
  }
  const pool = new pg.Pool({ connectionString })
  await pool.query(CREATE_USERS_TABLE)
  await pool.query(ADD_EXTERNAL_ID) // migrate pre-existing tables
  return new PgUserStore(pool)
}
