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

  it('upsertOAuth returning identity REFRESHES the row (avatar COALESCE + email_verified, NO status) and never inserts', async () => {
    // byExt SELECT then the refresh UPDATE (RETURNING *). The refresh must re-affirm
    // email_verified and adopt a fresh avatar via COALESCE($new, avatar_url) — but it must
    // NOT touch `status`, so a disabled/banned account can't be silently re-activated by login.
    const { db, calls } = fakeDb([
      { match: s => s.startsWith('SELECT') && s.includes('external_id'), rows: () => [row({ id: 'id1', external_id: 'github:7', avatar_url: 'https://av/old' })] },
      { match: s => s.startsWith('UPDATE'), rows: p => [row({ id: 'id1', external_id: 'github:7', avatar_url: (p[0] as string) ?? 'https://av/old' })] },
    ])
    const u = (await new PgUserStore(db).upsertOAuth({ externalId: 'github:7', email: 'ada@akis.dev', name: 'Ada', avatarUrl: 'https://av/new' }))!
    expect(u.externalId).toBe('github:7'); expect(u.avatarUrl).toBe('https://av/new')
    const upd = calls.find(c => c.text.startsWith('UPDATE'))!
    expect(upd.text).toMatch(/avatar_url = COALESCE\(\$1, avatar_url\)/)
    expect(upd.text).toMatch(/email_verified = true/)
    expect(upd.text).not.toMatch(/status/) // never re-activates a disabled account
    expect(upd.params).toEqual(['https://av/new', 'id1'])
    expect(calls.some(c => c.text.startsWith('INSERT'))).toBe(false)
  })

  it('upsertOAuth returning identity with NO avatar in the profile preserves the existing one (COALESCE keeps it)', async () => {
    // $1 = null when the profile carries no picture; COALESCE($1, avatar_url) keeps the stored avatar.
    const { db, calls } = fakeDb([
      { match: s => s.startsWith('SELECT') && s.includes('external_id'), rows: () => [row({ id: 'id1', external_id: 'github:7', avatar_url: 'https://av/old' })] },
      { match: s => s.startsWith('UPDATE'), rows: p => [row({ id: 'id1', external_id: 'github:7', avatar_url: (p[0] as string) ?? 'https://av/old' })] },
    ])
    const u = (await new PgUserStore(db).upsertOAuth({ externalId: 'github:7', email: 'ada@akis.dev', name: 'Ada' }))!
    expect(u.avatarUrl).toBe('https://av/old')
    expect(calls.find(c => c.text.startsWith('UPDATE'))!.params).toEqual([null, 'id1'])
  })

  it('upsertOAuth links a verified-email account to the identity (UPDATE, no INSERT) and marks it verified — but NOT active', async () => {
    const { db, calls } = fakeDb([
      { match: s => s.includes('WHERE external_id'), rows: () => [] },
      { match: s => s.includes('WHERE email'), rows: () => [row({ email: 'ada@akis.dev' })] },
      // The link UPDATE sets external_id + email_verified + COALESCE(avatar_url, $2),
      // and RETURNING * gives back the linked row (now carrying the identity + adopted avatar).
      { match: s => s.startsWith('UPDATE'), rows: p => [row({ id: 'id1', external_id: p[0] as string, avatar_url: p[1] as string })] },
    ])
    const u = (await new PgUserStore(db).upsertOAuth({ externalId: 'github:7', email: 'ada@akis.dev', name: 'Ada', avatarUrl: 'https://av/7' }))!
    expect(u.id).toBe('id1'); expect(u.externalId).toBe('github:7'); expect(u.avatarUrl).toBe('https://av/7')
    const upd = calls.find(c => c.text.startsWith('UPDATE'))!
    expect(upd.text).toMatch(/email_verified = true/)
    // Linking must NOT auto-reactivate the account (no `status='active'` write).
    expect(upd.text).not.toMatch(/status/)
    expect(upd.text).toMatch(/COALESCE\(avatar_url, \$2\)/)
    expect(upd.params).toEqual(['github:7', 'https://av/7', 'id1'])
    expect(calls.some(c => c.text.startsWith('INSERT'))).toBe(false)
  })

  it('upsertOAuth does NOT rebind an email account already bound to a different identity (parity with in-memory)', async () => {
    // byExt miss, but the email account already carries external_id 'github:old'.
    // A new login with 'github:new' must NOT clobber the DB and must return the
    // ORIGINAL identity (the in-memory store returns `existing` unchanged) — never a
    // fabricated externalId that was never persisted.
    const { db, calls } = fakeDb([
      { match: s => s.includes('WHERE external_id'), rows: () => [] },
      { match: s => s.includes('WHERE email'), rows: () => [row({ id: 'id1', external_id: 'github:old' })] },
    ])
    const u = (await new PgUserStore(db).upsertOAuth({ externalId: 'github:new', email: 'ada@akis.dev', name: 'Ada' }))!
    expect(u.externalId).toBe('github:old')
    expect(calls.some(c => c.text.startsWith('UPDATE'))).toBe(false)
    expect(calls.some(c => c.text.startsWith('INSERT'))).toBe(false)
  })

  it('upsertOAuth inserts a new empty-password user with external_id + avatar when nothing matches, created verified + active', async () => {
    const { db, calls } = fakeDb([
      { match: s => s.startsWith('SELECT'), rows: () => [] },
      { match: s => s.startsWith('INSERT'), rows: p => [row({ id: p[0] as string, name: p[1] as string, email: p[2] as string, password_hash: p[3] as string, external_id: p[4] as string, avatar_url: p[5] as string })] },
    ])
    const u = (await new PgUserStore(db, () => 'oauth-id').upsertOAuth({ externalId: 'github:9', email: 'New@akis.dev', name: 'New', avatarUrl: 'https://av/9' }))!
    expect(u.id).toBe('oauth-id'); expect(u.avatarUrl).toBe('https://av/9')
    const ins = calls.find(c => c.text.startsWith('INSERT'))!
    // OAuth create = provider-verified ⇒ email_verified=true + status='active' baked into the SQL.
    expect(ins.text).toMatch(/email_verified/); expect(ins.text).toMatch(/status/)
    expect(ins.text).toMatch(/true,'active'/)
    expect(ins.params).toEqual(['oauth-id', 'New', 'new@akis.dev', '', 'github:9', 'https://av/9'])
  })

  it('upsertOAuth create passes avatar=null when the profile has none (no explicit undefined into SQL)', async () => {
    const { db, calls } = fakeDb([
      { match: s => s.startsWith('SELECT'), rows: () => [] },
      { match: s => s.startsWith('INSERT'), rows: p => [row({ id: p[0] as string, external_id: p[4] as string })] },
    ])
    await new PgUserStore(db, () => 'oauth-id').upsertOAuth({ externalId: 'google:11', email: 'np@akis.dev', name: 'NP' })
    expect(calls.find(c => c.text.startsWith('INSERT'))!.params).toEqual(['oauth-id', 'NP', 'np@akis.dev', '', 'google:11', null])
  })
})
