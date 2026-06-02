import { describe, it, expect } from 'vitest'
import { createPgPool, runMigrations } from '../../src/store/pg.js'

/**
 * REAL-Postgres migration integration test (the fake-client unit tests can only prove a
 * statement is ISSUED, never that the DDL is valid or that constraints actually hold
 * after migration — exactly the coverage gap that let the external_id-uniqueness
 * divergence go unnoticed). Gated on AKIS_TEST_DATABASE_URL so it runs in CI (a postgres
 * service) and is skipped locally where no throwaway DB is available.
 */
const url = process.env.AKIS_TEST_DATABASE_URL

describe.skipIf(!url)('runMigrations against real Postgres', () => {
  it('is idempotent and enforces external_id uniqueness while allowing multiple NULLs', async () => {
    const pool = await createPgPool(url!)
    try {
      // Deterministic slate: a real DB persists across runs.
      await pool.query('DROP TABLE IF EXISTS sessions, workflows, users CASCADE')

      await runMigrations(pool)
      await runMigrations(pool) // second run MUST NOT throw — every statement is idempotent

      // external_id is unique (the partial index works on a freshly migrated table).
      await pool.query("INSERT INTO users (id,name,email,password_hash,external_id) VALUES ('u1','A','a@x.dev','','gh:1')")
      await expect(
        pool.query("INSERT INTO users (id,name,email,password_hash,external_id) VALUES ('u2','B','b@x.dev','','gh:1')"),
      ).rejects.toMatchObject({ code: '23505' })

      // …but multiple password-only users (NULL external_id) are allowed (partial index).
      await pool.query("INSERT INTO users (id,name,email,password_hash) VALUES ('u3','C','c@x.dev','')")
      await pool.query("INSERT INTO users (id,name,email,password_hash) VALUES ('u4','D','d@x.dev','')")
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM users WHERE external_id IS NULL')
      expect(Number(rows[0]!.n)).toBe(2)
    } finally {
      if (pool.end) await pool.end()
    }
  })

  it('adds external_id uniqueness to a LEGACY users table that predates the column (the actual upgrade path)', async () => {
    const pool = await createPgPool(url!)
    try {
      await pool.query('DROP TABLE IF EXISTS sessions, workflows, users CASCADE')
      // A legacy users table from before external_id existed: the column — and thus its
      // inline UNIQUE — is ABSENT, so on this table only the CREATE_USERS_EXTERNAL_ID_UNIQUE
      // migration (not an inline constraint) can enforce identity uniqueness.
      await pool.query(`CREATE TABLE users (
        id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE,
        password_hash text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now())`)

      await runMigrations(pool) // CREATE TABLE no-ops; ADD COLUMN + the partial unique index apply

      await pool.query("INSERT INTO users (id,name,email,password_hash,external_id) VALUES ('u1','A','a@x.dev','','gh:1')")
      await expect(
        pool.query("INSERT INTO users (id,name,email,password_hash,external_id) VALUES ('u2','B','b@x.dev','','gh:1')"),
      ).rejects.toMatchObject({ code: '23505' }) // enforced by the migration's index, not an inline constraint
    } finally {
      if (pool.end) await pool.end()
    }
  })
})
