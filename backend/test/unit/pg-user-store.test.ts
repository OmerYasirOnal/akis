import { describe, it, expect } from 'vitest'
import { PgUserStore, type SqlClient } from '../../src/auth/PgUserStore.js'
import { EmailTakenError } from '../../src/auth/UserStore.js'

/** A fake SqlClient: records queries and returns scripted rows by a matcher. */
function fakeDb(handlers: { match: (sql: string) => boolean; rows: (params: unknown[]) => Array<Record<string, unknown>>; throws?: { code: string } }[]) {
  const calls: { text: string; params: unknown[] }[] = []
  const db: SqlClient = {
    async query(text, params = []) {
      calls.push({ text, params })
      const h = handlers.find(h => h.match(text))
      if (!h) return { rows: [] }
      if (h.throws) throw h.throws
      return { rows: h.rows(params) }
    },
  }
  return { db, calls }
}

const row = (o: Partial<Record<string, unknown>>) => ({ id: 'id1', name: 'Ada', email: 'ada@akis.dev', password_hash: 'h', created_at: '2026-06-02T00:00:00Z', ...o })

describe('PgUserStore', () => {
  it('create inserts a lowercased email and maps the row to AuthUser', async () => {
    const { db, calls } = fakeDb([{ match: s => s.startsWith('INSERT'), rows: p => [row({ id: p[0] as string, name: p[1] as string, email: p[2] as string, password_hash: p[3] as string })] }])
    const store = new PgUserStore(db, () => 'fixed-id')
    const u = await store.create({ name: ' Ada ', email: 'ADA@akis.dev', passwordHash: 'hash' })
    expect(u).toMatchObject({ id: 'fixed-id', name: 'Ada', email: 'ada@akis.dev', passwordHash: 'hash' })
    expect(calls[0]!.text).toMatch(/INSERT INTO users/)
    expect(calls[0]!.params).toEqual(['fixed-id', 'Ada', 'ada@akis.dev', 'hash'])
  })

  it('create maps a unique-violation to EmailTakenError', async () => {
    const { db } = fakeDb([{ match: s => s.startsWith('INSERT'), rows: () => [], throws: { code: '23505' } }])
    await expect(new PgUserStore(db).create({ name: 'A', email: 'a@b.com', passwordHash: 'h' })).rejects.toBeInstanceOf(EmailTakenError)
  })

  it('findByEmail/findById SELECT and return undefined when no row', async () => {
    const { db } = fakeDb([{ match: s => s.startsWith('SELECT'), rows: p => (p[0] === 'ada@akis.dev' ? [row({})] : []) }])
    const store = new PgUserStore(db)
    expect((await store.findByEmail('ADA@akis.dev'))?.email).toBe('ada@akis.dev')
    expect(await store.findById('nope')).toBeUndefined()
  })

  it('updatePassword issues an UPDATE', async () => {
    const { db, calls } = fakeDb([{ match: s => s.startsWith('UPDATE'), rows: () => [] }])
    await new PgUserStore(db).updatePassword('id1', 'newhash')
    expect(calls[0]!.text).toMatch(/UPDATE users SET password_hash/)
    expect(calls[0]!.params).toEqual(['newhash', 'id1'])
  })

  it('upsertOAuth returns the existing user when found, else inserts an empty-password user', async () => {
    // existing
    const found = fakeDb([{ match: s => s.startsWith('SELECT'), rows: () => [row({ email: 'ada@akis.dev' })] }])
    expect((await new PgUserStore(found.db).upsertOAuth({ email: 'ada@akis.dev', name: 'Ada' })).id).toBe('id1')
    expect(found.calls.some(c => c.text.startsWith('INSERT'))).toBe(false)
    // new
    const fresh = fakeDb([
      { match: s => s.startsWith('SELECT'), rows: () => [] },
      { match: s => s.startsWith('INSERT'), rows: p => [row({ id: p[0] as string, email: p[2] as string, password_hash: p[3] as string })] },
    ])
    const u = await new PgUserStore(fresh.db, () => 'oauth-id').upsertOAuth({ email: 'New@akis.dev', name: 'New' })
    expect(u.id).toBe('oauth-id')
    expect(fresh.calls.find(c => c.text.startsWith('INSERT'))!.params).toEqual(['oauth-id', 'New', 'new@akis.dev', ''])
  })
})
