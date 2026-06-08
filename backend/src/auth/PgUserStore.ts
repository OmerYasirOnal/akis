import { randomUUID } from 'node:crypto'
import { type AuthUser, type AuthProvider, type UserStorePort, EmailTakenError, providerOf } from './UserStore.js'
import { type SqlClient, createPgPool, runMigrations } from '../store/pg.js'

/** Re-exported from the shared Pg seam (store/pg.ts) for backward compatibility —
 *  callers and tests that import `SqlClient` from here keep working. */
export type { SqlClient }

interface Row { id: string; name: string; email: string; password_hash: string; created_at: string | Date; external_id?: string | null; token_version?: number | string | null; tier?: string | null; stripe_customer_id?: string | null; avatar_url?: string | null; last_login_provider?: string | null }
const toUser = (r: Row): AuthUser => ({
  id: r.id, name: r.name, email: r.email, passwordHash: r.password_hash,
  createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  ...(r.external_id ? { externalId: r.external_id } : {}),
  ...(r.token_version !== null && r.token_version !== undefined ? { tokenVersion: Number(r.token_version) } : {}),
  ...(r.tier === 'pro' ? { tier: 'pro' as const } : {}),
  ...(r.stripe_customer_id ? { stripeCustomerId: r.stripe_customer_id } : {}),
  ...(r.avatar_url ? { avatarUrl: r.avatar_url } : {}),
  // The provider used for the most-recent login (drives toPublic's badge). Only the three known
  // values are accepted back — an unexpected DB value falls through (toPublic then derives from
  // externalId), so a stray string can't widen AuthProvider.
  ...(r.last_login_provider === 'github' || r.last_login_provider === 'google' || r.last_login_provider === 'password' ? { lastLoginProvider: r.last_login_provider as AuthProvider } : {}),
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

  async upsertOAuth(input: { externalId: string; email: string; name: string; avatarUrl?: string }, opts?: { allowCreate?: boolean }): Promise<AuthUser | null> {
    const avatar = input.avatarUrl ?? null
    // The provider used for THIS login — recorded on every path so toPublic badges how the user
    // signed in NOW, even when the account is permanently bound to a different identity.
    const provider = providerOf(input.externalId)
    // 1) same provider identity returning? REFRESH the row rather than returning it unchanged.
    //    The provider re-verified this identity every login, so re-affirm email_verified and pick
    //    up a fresh avatar (COALESCE keeps the existing picture when the profile carries none).
    //    Deliberately NOT touching `status`: an existing user who logged in BEFORE the avatar
    //    feature must get their photo, but a 'disabled'/'deleted' account must NOT be silently
    //    re-activated just because they can still pass the provider's email check.
    const byExt = await this.db.query('SELECT * FROM users WHERE external_id = $1', [input.externalId])
    if (byExt.rows[0]) {
      const { rows } = await this.db.query(
        'UPDATE users SET avatar_url = COALESCE($1, avatar_url), email_verified = true, last_login_provider = $2 WHERE id = $3 RETURNING *',
        [avatar, provider, (byExt.rows[0] as unknown as Row).id],
      )
      return toUser((rows[0] ?? byExt.rows[0]) as unknown as Row)
    }
    const email = norm(input.email)
    // 2) link to the (provider-verified) email account, recording the identity.
    const byEmail = await this.findByEmail(email)
    if (byEmail) {
      // Link this provider identity to the verified-email account ONLY if it isn't already bound.
      // If it already carries a (different) identity, do NOT clobber external_id — that identity is
      // permanent (don't-clobber-identity invariant). But still RECORD the provider used this login
      // (so the badge is honest) and refresh the avatar when the current login carries one, so the
      // photo follows it too. Status is deliberately untouched (no silent re-activation). RETURNING *
      // so toUser reflects the actual row (preserving external_id 'github:…').
      if (byEmail.externalId) {
        const { rows } = await this.db.query(
          `UPDATE users SET last_login_provider = $1, avatar_url = COALESCE($2, avatar_url) WHERE id = $3 RETURNING *`,
          [provider, avatar, byEmail.id],
        )
        return rows[0] ? toUser(rows[0] as unknown as Row) : { ...byEmail, lastLoginProvider: provider }
      }
      // Link + mark provider-verified (the provider verified this email), record the login provider,
      // and adopt the avatar only when the row has none (COALESCE keeps an existing picture).
      // RETURNING * so we reflect whatever the row actually carries (e.g. a pre-existing avatar_url).
      // Deliberately NOT writing status='active' here — linking an identity to an existing account
      // must not silently re-activate a 'disabled'/'deleted' one (same fail-closed reasoning as the
      // returning path).
      const { rows } = await this.db.query(
        `UPDATE users SET external_id = $1, email_verified = true, avatar_url = COALESCE(avatar_url, $2), last_login_provider = $3 WHERE id = $4 RETURNING *`,
        [input.externalId, avatar, provider, byEmail.id],
      )
      return rows[0] ? toUser(rows[0] as unknown as Row) : { ...byEmail, externalId: input.externalId, lastLoginProvider: provider }
    }
    // Step 3 (create) — REFUSED when signup is disabled: OAuth must not mint a new account.
    if (opts?.allowCreate === false) return null
    // 3) create — race-safe: a concurrent first login may insert the same email/identity.
    //    Provider-verified email ⇒ the new account is created verified + active.
    try {
      const { rows } = await this.db.query(
        `INSERT INTO users (id, name, email, password_hash, external_id, avatar_url, email_verified, status, last_login_provider) VALUES ($1,$2,$3,$4,$5,$6,true,'active',$7) RETURNING *`,
        [this.genId(), input.name.trim() || email, email, '', input.externalId, avatar, provider],
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

  async setSubscription(id: string, patch: { tier?: import('../usage/quota.js').Tier; stripeCustomerId?: string }): Promise<AuthUser | undefined> {
    // COALESCE keeps an unspecified field unchanged (additive). Either field may be set independently.
    const { rows } = await this.db.query(
      'UPDATE users SET tier = COALESCE($1, tier), stripe_customer_id = COALESCE($2, stripe_customer_id) WHERE id = $3 RETURNING *',
      [patch.tier ?? null, patch.stripeCustomerId ?? null, id],
    )
    return rows[0] ? toUser(rows[0] as unknown as Row) : undefined
  }
  async findByStripeCustomerId(customerId: string): Promise<AuthUser | undefined> {
    const { rows } = await this.db.query('SELECT * FROM users WHERE stripe_customer_id = $1', [customerId])
    return rows[0] ? toUser(rows[0] as unknown as Row) : undefined
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
