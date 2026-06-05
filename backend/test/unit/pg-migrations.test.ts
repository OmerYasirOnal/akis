import { describe, it, expect } from 'vitest'
import { runMigrations, createPgPool, type SqlClient } from '../../src/store/pg.js'

/** A fake SqlClient that records every SQL statement it is asked to run. */
function recordingDb() {
  const texts: string[] = []
  const db: SqlClient = {
    async query(text) {
      texts.push(text)
      return { rows: [] }
    },
  }
  return { db, texts }
}

describe('runMigrations', () => {
  it('creates the users, sessions and workflows tables (idempotent CREATE TABLE IF NOT EXISTS)', async () => {
    const { db, texts } = recordingDb()
    await runMigrations(db)
    const all = texts.join('\n')
    expect(all).toMatch(/CREATE TABLE IF NOT EXISTS users/)
    expect(all).toMatch(/CREATE TABLE IF NOT EXISTS sessions/)
    expect(all).toMatch(/CREATE TABLE IF NOT EXISTS workflows/)
  })

  it('creates the vector_chunks table for the persistent RAG corpus (idempotent CREATE TABLE IF NOT EXISTS + index)', async () => {
    const { db, texts } = recordingDb()
    await runMigrations(db)
    const all = texts.join('\n')
    expect(all).toMatch(/CREATE TABLE IF NOT EXISTS vector_chunks/)
    // a tenancy index so the hydration/candidate scan stays cheap, idempotent.
    expect(all).toMatch(/CREATE INDEX IF NOT EXISTS \w+ ON vector_chunks/i)
  })

  it('creates the user_usage table for the per-user token quota (ADD pattern; idempotent re-run)', async () => {
    const { db, texts } = recordingDb()
    await runMigrations(db)
    await runMigrations(db) // idempotent: a second boot re-runs the same IF NOT EXISTS DDL
    const all = texts.join('\n')
    expect(all).toMatch(/CREATE TABLE IF NOT EXISTS user_usage/)
    expect(all).toMatch(/owner_id\s+text PRIMARY KEY/) // the UPSERT key
    expect(all).toMatch(/used_tokens\s+bigint/)        // bigint: lifetime counts exceed int4
  })

  it('runs the idempotent external_id ALTER for pre-existing user tables', async () => {
    const { db, texts } = recordingDb()
    await runMigrations(db)
    expect(texts.some(t => /ALTER TABLE users ADD COLUMN IF NOT EXISTS external_id/.test(t))).toBe(true)
  })

  it('runs the idempotent publish ALTER for pre-existing sessions tables (additive, NON-GATE field)', async () => {
    // `publish` is an additive, non-gate field; an upgraded sessions table that pre-dates it must
    // get the column via ADD COLUMN IF NOT EXISTS, else a successful publish is silently dropped on
    // Postgres and the FE PublishButton never surfaces the live URL / honest failure reason.
    const { db, texts } = recordingDb()
    await runMigrations(db)
    expect(texts.some(t => /ALTER TABLE sessions ADD COLUMN IF NOT EXISTS publish jsonb/.test(t))).toBe(true)
    // the fresh-table DDL must also carry the column so new DBs match upgraded ones.
    expect(texts.join('\n')).toMatch(/CREATE TABLE IF NOT EXISTS sessions[\s\S]*publish\s+jsonb/)
  })

  it('enforces external_id uniqueness via a dedicated index (so upgraded DBs match fresh ones)', async () => {
    // A fresh DB gets `external_id text UNIQUE` inline, but the ADD COLUMN migration that
    // upgrades a pre-existing users table adds NO constraint — without a dedicated unique
    // index, an upgraded DB lets duplicate OAuth identities exist. The migration set must
    // therefore include an idempotent unique index on external_id.
    const { db, texts } = recordingDb()
    await runMigrations(db)
    const all = texts.join('\n')
    expect(all).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS \w+ ON users ?\(external_id\)/i)
  })

  it('runs every migration statement to completion (no statement is skipped)', async () => {
    const { db, texts } = recordingDb()
    await runMigrations(db)
    // users (create + alter) + sessions + workflows = at least 4 statements.
    expect(texts.length).toBeGreaterThanOrEqual(4)
  })
})

describe('createPgPool', () => {
  it('throws a clear, actionable error when the `pg` package is not installed', async () => {
    // `pg` is a shipped dependency, so we can't rely on the env lacking it — inject an
    // importer that rejects (as a missing module would) and assert createPgPool surfaces
    // the clear "pg not installed" message rather than a raw module-not-found.
    const missing = () => Promise.reject(new Error("Cannot find package 'pg'"))
    await expect(createPgPool('postgres://localhost/akis', missing)).rejects.toThrow(/pg.*not installed/i)
  })

  it('attaches an idle-client error listener and a connection timeout (a dead DB connection must not crash the process)', async () => {
    // node-postgres emits an 'error' event on idle clients when a backend connection dies
    // (DB restart/failover/admin terminate). With NO listener that EventEmitter error
    // becomes an uncaught exception → process crash. createPgPool must attach a listener
    // and set a finite connectionTimeoutMillis so an unreachable DB fails fast.
    const cfgs: Array<Record<string, unknown>> = []
    const events: string[] = []
    const fakeImport = () => Promise.resolve({
      Pool: class {
        constructor(cfg: Record<string, unknown>) { cfgs.push(cfg) }
        async query() { return { rows: [] } }
        on(event: string) { events.push(event) }
      },
    })
    await createPgPool('postgres://localhost/akis', fakeImport)
    expect(events).toContain('error')
    expect(Number(cfgs[0]!.connectionTimeoutMillis)).toBeGreaterThan(0)
  })
})
