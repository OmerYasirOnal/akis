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

  it('runs the idempotent external_id ALTER for pre-existing user tables', async () => {
    const { db, texts } = recordingDb()
    await runMigrations(db)
    expect(texts.some(t => /ALTER TABLE users ADD COLUMN IF NOT EXISTS external_id/.test(t))).toBe(true)
  })

  it('runs every migration statement to completion (no statement is skipped)', async () => {
    const { db, texts } = recordingDb()
    await runMigrations(db)
    // users (create + alter) + sessions + workflows = at least 4 statements.
    expect(texts.length).toBeGreaterThanOrEqual(4)
  })
})

describe('createPgPool', () => {
  it('returns a usable SqlClient (a pg Pool) WITHOUT opening a connection', async () => {
    // `pg` ships as a real dependency (the self-host image needs it), so the lazy
    // import resolves and createPgPool returns a Pool. Crucially, `new Pool()` does NOT
    // dial the DB — construction is lazy — so this stays offline-safe in CI: we only
    // assert the returned object satisfies the SqlClient shape (a `query` method).
    const client = await createPgPool('postgres://localhost/akis')
    expect(typeof client.query).toBe('function')
    // Best-effort cleanup so the idle pool never keeps the test runner alive.
    await (client as unknown as { end?: () => Promise<void> }).end?.()
  })
})
