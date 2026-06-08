import { describe, it, expect } from 'vitest'
import { PgUserStore, type SqlClient } from '../../src/auth/PgUserStore.js'
import { EmailTakenError, toPublic } from '../../src/auth/UserStore.js'

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
    expect(upd.text).toMatch(/last_login_provider = \$2/) // records the provider used this login
    expect(upd.text).not.toMatch(/status/) // never re-activates a disabled account
    expect(upd.params).toEqual(['https://av/new', 'github', 'id1'])
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
    expect(calls.find(c => c.text.startsWith('UPDATE'))!.params).toEqual([null, 'github', 'id1'])
  })

  it('upsertOAuth links a verified-email account to the identity (UPDATE, no INSERT) and marks it verified — but NOT active', async () => {
    const { db, calls } = fakeDb([
      { match: s => s.includes('WHERE external_id'), rows: () => [] },
      { match: s => s.includes('WHERE email'), rows: () => [row({ email: 'ada@akis.dev' })] },
      // The link UPDATE sets external_id + email_verified + COALESCE(avatar_url, $2) + last_login_provider,
      // and RETURNING * gives back the linked row (now carrying the identity + adopted avatar + provider).
      { match: s => s.startsWith('UPDATE'), rows: p => [row({ id: 'id1', external_id: p[0] as string, avatar_url: p[1] as string, last_login_provider: p[2] as string })] },
    ])
    const u = (await new PgUserStore(db).upsertOAuth({ externalId: 'github:7', email: 'ada@akis.dev', name: 'Ada', avatarUrl: 'https://av/7' }))!
    expect(u.id).toBe('id1'); expect(u.externalId).toBe('github:7'); expect(u.avatarUrl).toBe('https://av/7')
    expect(u.lastLoginProvider).toBe('github') // RETURNING * round-trips the recorded login provider
    const upd = calls.find(c => c.text.startsWith('UPDATE'))!
    expect(upd.text).toMatch(/email_verified = true/)
    expect(upd.text).toMatch(/last_login_provider = \$3/) // records the provider used this login
    // Linking must NOT auto-reactivate the account (no `status='active'` write).
    expect(upd.text).not.toMatch(/status/)
    expect(upd.text).toMatch(/COALESCE\(avatar_url, \$2\)/)
    expect(upd.params).toEqual(['github:7', 'https://av/7', 'github', 'id1'])
    expect(calls.some(c => c.text.startsWith('INSERT'))).toBe(false)
  })

  it('upsertOAuth does NOT rebind an email account already bound to a different identity, but records the login provider + refreshes the avatar (the cross-provider badge fix)', async () => {
    // REPRODUCES the bug: the email account is already bound to external_id 'github:115497334'.
    // A login via google with the SAME email must NOT clobber external_id (don't-clobber-identity),
    // must NOT touch status, but MUST set last_login_provider='google' (so the badge reflects THIS
    // login) and COALESCE($newAvatar, avatar_url) (so the photo follows it too).
    const { db, calls } = fakeDb([
      { match: s => s.includes('WHERE external_id'), rows: () => [] },
      { match: s => s.includes('WHERE email'), rows: () => [row({ id: 'id1', external_id: 'github:115497334' })] },
      // The branch UPDATE: external_id is UNTOUCHED, so RETURNING * still carries 'github:115497334'.
      { match: s => s.startsWith('UPDATE'), rows: p => [row({ id: 'id1', external_id: 'github:115497334', last_login_provider: p[0] as string, avatar_url: (p[1] as string) ?? null })] },
    ])
    const u = (await new PgUserStore(db).upsertOAuth({ externalId: 'google:200', email: 'engomeryasironal@gmail.com', name: 'Omer', avatarUrl: 'https://av/G' }))!
    expect(u.externalId).toBe('github:115497334') // identity preserved — never clobbered
    expect(u.lastLoginProvider).toBe('google')    // badge source reflects the provider used this login
    expect(u.avatarUrl).toBe('https://av/G')
    const upd = calls.find(c => c.text.startsWith('UPDATE'))!
    expect(upd.text).toMatch(/last_login_provider = \$1/)
    expect(upd.text).toMatch(/avatar_url = COALESCE\(\$2, avatar_url\)/)
    expect(upd.text).not.toMatch(/external_id/) // the bound identity is never written
    expect(upd.text).not.toMatch(/status/)      // never re-activates a disabled account
    expect(upd.params).toEqual(['google', 'https://av/G', 'id1'])
    expect(calls.some(c => c.text.startsWith('INSERT'))).toBe(false)
  })

  it('upsertOAuth inserts a new empty-password user with external_id + avatar when nothing matches, created verified + active', async () => {
    const { db, calls } = fakeDb([
      { match: s => s.startsWith('SELECT'), rows: () => [] },
      { match: s => s.startsWith('INSERT'), rows: p => [row({ id: p[0] as string, name: p[1] as string, email: p[2] as string, password_hash: p[3] as string, external_id: p[4] as string, avatar_url: p[5] as string, last_login_provider: p[6] as string })] },
    ])
    const u = (await new PgUserStore(db, () => 'oauth-id').upsertOAuth({ externalId: 'github:9', email: 'New@akis.dev', name: 'New', avatarUrl: 'https://av/9' }))!
    expect(u.id).toBe('oauth-id'); expect(u.avatarUrl).toBe('https://av/9'); expect(u.lastLoginProvider).toBe('github')
    const ins = calls.find(c => c.text.startsWith('INSERT'))!
    // OAuth create = provider-verified ⇒ email_verified=true + status='active' baked into the SQL.
    expect(ins.text).toMatch(/email_verified/); expect(ins.text).toMatch(/status/)
    expect(ins.text).toMatch(/true,'active'/)
    expect(ins.text).toMatch(/last_login_provider/) // records the provider used this login
    expect(ins.params).toEqual(['oauth-id', 'New', 'new@akis.dev', '', 'github:9', 'https://av/9', 'github'])
  })

  it('upsertOAuth create passes avatar=null when the profile has none (no explicit undefined into SQL)', async () => {
    const { db, calls } = fakeDb([
      { match: s => s.startsWith('SELECT'), rows: () => [] },
      { match: s => s.startsWith('INSERT'), rows: p => [row({ id: p[0] as string, external_id: p[4] as string })] },
    ])
    await new PgUserStore(db, () => 'oauth-id').upsertOAuth({ externalId: 'google:11', email: 'np@akis.dev', name: 'NP' })
    expect(calls.find(c => c.text.startsWith('INSERT'))!.params).toEqual(['oauth-id', 'NP', 'np@akis.dev', '', 'google:11', null, 'google'])
  })

  // ── provider-badge FR-11 / NFR-2: toUser must NOT widen AuthProvider. An unrecognized DB
  //    `last_login_provider` (a future/legacy value, a typo, or NULL) maps to lastLoginProvider
  //    === undefined, so the wire badge (toPublic) then DERIVES the provider from externalId. ──
  it('findById maps an UNRECOGNIZED last_login_provider to lastLoginProvider undefined (derive from externalId)', async () => {
    for (const bad of ['saml', 'garbage', null]) {
      const { db } = fakeDb([{ match: s => s.startsWith('SELECT'), rows: () => [row({ external_id: 'github:7', last_login_provider: bad })] }])
      const u = (await new PgUserStore(db).findById('id1'))!
      // The stray value is dropped — never coerced onto the union.
      expect(u.lastLoginProvider).toBeUndefined()
      // toPublic then falls back to deriving from the bound externalId: github here.
      expect(toPublic(u).provider).toBe('github')
    }
  })

  it('findById KEEPS a recognized last_login_provider and toPublic prefers it over the externalId derivation', async () => {
    // Account is bound to a github identity but signed in THIS time via google (cross-provider).
    const { db } = fakeDb([{ match: s => s.startsWith('SELECT'), rows: () => [row({ external_id: 'github:7', last_login_provider: 'google' })] }])
    const u = (await new PgUserStore(db).findById('id1'))!
    expect(u.lastLoginProvider).toBe('google')
    expect(toPublic(u).provider).toBe('google') // last-login wins over the bound identity
  })

  // ── provider-badge NFR-5: the create race. SELECTs miss, INSERT loses the race (23505), and the
  //    follow-up `WHERE external_id = $1 OR email = $2` finds the row the winner inserted. We must
  //    RETURN that row (no throw), carrying its last_login_provider intact. A regression that
  //    re-threw on 23505, or dropped the recovery SELECT, would FAIL here. ──
  it('upsertOAuth recovers from a concurrent-insert 23505 by re-SELECTing (external_id OR email) and returns that row with its provider', async () => {
    const { db, calls } = fakeDb([
      { match: s => s.startsWith('SELECT') && s.includes('external_id = $1') && !s.includes('OR email'), rows: () => [] }, // byExt miss
      { match: s => s.startsWith('SELECT') && s.includes('WHERE email'), rows: () => [] },                                   // byEmail miss
      { match: s => s.startsWith('INSERT'), rows: () => [], throws: { code: '23505' } },                                     // lost the race
      // Recovery SELECT: `WHERE external_id = $1 OR email = $2` — the row the concurrent winner wrote.
      { match: s => s.startsWith('SELECT') && s.includes('OR email'), rows: p => [row({ id: 'winner', external_id: p[0] as string, last_login_provider: 'github' })] },
    ])
    const u = (await new PgUserStore(db).upsertOAuth({ externalId: 'github:42', email: 'race@akis.dev', name: 'Race' }))!
    expect(u.id).toBe('winner')
    expect(u.externalId).toBe('github:42')
    expect(u.lastLoginProvider).toBe('github') // the recovered row's provider is preserved
    // The recovery SELECT was actually issued with BOTH the external_id and the lowercased email.
    const recover = calls.find(c => c.text.startsWith('SELECT') && c.text.includes('OR email'))!
    expect(recover.params).toEqual(['github:42', 'race@akis.dev'])
  })

  it('upsertOAuth RE-THROWS a non-unique INSERT error (only 23505 triggers the race recovery)', async () => {
    const { db } = fakeDb([
      { match: s => s.startsWith('SELECT'), rows: () => [] },
      { match: s => s.startsWith('INSERT'), rows: () => [], throws: { code: '40001' } }, // serialization failure, not a dup
    ])
    await expect(new PgUserStore(db).upsertOAuth({ externalId: 'github:99', email: 'x@akis.dev', name: 'X' })).rejects.toMatchObject({ code: '40001' })
  })
})
