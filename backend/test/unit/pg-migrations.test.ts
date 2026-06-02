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
  it('throws a clear, actionable error when the `pg` package is not installed', async () => {
    // `pg` is a shipped dependency, so we can't rely on the env lacking it — inject an
    // importer that rejects (as a missing module would) and assert createPgPool surfaces
    // the clear "pg not installed" message rather than a raw module-not-found.
    const missing = () => Promise.reject(new Error("Cannot find package 'pg'"))
    await expect(createPgPool('postgres://localhost/akis', missing)).rejects.toThrow(/pg.*not installed/i)
  })
})
