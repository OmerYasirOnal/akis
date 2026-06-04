import { describe, it, expect } from 'vitest'
import type { SessionState, ApprovalToken, VerifyToken } from '@akis/shared'
import { isVerified } from '@akis/shared'
import { PgSessionStore } from '../../src/store/PgSessionStore.js'
import type { SqlClient } from '../../src/store/pg.js'

/** A fake SqlClient: records every query and returns scripted rows by a matcher. */
function fakeDb(handlers: { match: (sql: string) => boolean; rows: (params: unknown[]) => Array<Record<string, unknown>> }[]) {
  const calls: { text: string; params: unknown[] }[] = []
  const db: SqlClient = {
    async query(text, params = []) {
      calls.push({ text, params })
      const h = handlers.find(h => h.match(text))
      return { rows: h ? h.rows(params) : [] }
    },
  }
  return { db, calls }
}

/** A DB row as Postgres would return it for the `sessions` table. */
function dbRow(o: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 's1', status: 'composing', idea: 'an idea', owner_id: null,
    spec: null, approval: null, code: null, verify_token: null, version: 0,
    ...o,
  }
}

const baseSession = (o: Partial<SessionState> = {}): SessionState =>
  ({ id: 's1', status: 'composing', idea: 'an idea', version: 0, ...o })

describe('PgSessionStore', () => {
  it('create INSERTs the mapped columns and round-trips back through get()', async () => {
    const { db, calls } = fakeDb([
      { match: s => s.startsWith('INSERT'), rows: () => [] },
    ])
    const store = new PgSessionStore(db)
    await store.create(baseSession({ ownerId: 'u1' }))
    const insert = calls.find(c => c.text.startsWith('INSERT'))!
    expect(insert.text).toMatch(/INSERT INTO sessions/)
    // id, status, idea, owner_id and version are persisted.
    expect(insert.params).toContain('s1')
    expect(insert.params).toContain('composing')
    expect(insert.params).toContain('u1')
    expect(insert.params).toContain(0)
  })

  it('get() maps a row back to SessionState (jsonb spec/code, owner_id → ownerId)', async () => {
    const { db } = fakeDb([
      { match: s => s.startsWith('SELECT'), rows: () => [dbRow({ owner_id: 'u1', spec: { title: 'T', body: 'B' }, version: 2 })] },
    ])
    const got = await new PgSessionStore(db).get('s1')
    expect(got).toMatchObject({ id: 's1', status: 'composing', idea: 'an idea', ownerId: 'u1', version: 2, spec: { title: 'T', body: 'B' } })
    // absent optionals must NOT appear as undefined-valued keys (exactOptionalPropertyTypes).
    expect('approval' in got!).toBe(false)
    expect('verifyToken' in got!).toBe(false)
  })

  it('get() returns undefined when no row exists', async () => {
    const { db } = fakeDb([{ match: s => s.startsWith('SELECT'), rows: () => [] }])
    expect(await new PgSessionStore(db).get('nope')).toBeUndefined()
  })

  it('persists the edit-mode `base` on create and round-trips it through get() (Phase B.5)', async () => {
    const base = { files: [{ filePath: 'index.html', content: '<html>v1</html>' }], fromSession: 'prior' }
    const { db, calls } = fakeDb([
      { match: s => s.startsWith('INSERT'), rows: () => [] },
      { match: s => s.startsWith('SELECT'), rows: () => [dbRow({ base })] },
    ])
    const store = new PgSessionStore(db)
    await store.create(baseSession({ base }))
    const insert = calls.find(c => c.text.startsWith('INSERT'))!
    // The INSERT carries the base column (jsonb) — it is NOT silently dropped on Postgres.
    expect(insert.text).toMatch(/\bbase\b/)
    expect(insert.params.some(p => p != null && JSON.stringify(p).includes('prior'))).toBe(true)
    // …and it round-trips back to SessionState.base.
    const got = await store.get('s1')
    expect(got!.base).toEqual(base)
  })

  it('`base` is NOT writable via the generic update() (set-only-at-create, like the gate columns)', async () => {
    const { db, calls } = fakeDb([
      { match: s => s.startsWith('UPDATE'), rows: () => [dbRow({ version: 1 })] },
    ])
    // SessionPatch excludes `base` at the type level; assert the RUNTIME allowlist too
    // (a polluted patch object sneaking `base` through must be ignored, not written).
    const polluted = { status: 'building', base: { files: [], fromSession: 'evil' } } as unknown as Parameters<PgSessionStore['update']>[1]
    await new PgSessionStore(db).update('s1', polluted, 0)
    const upd = calls.find(c => c.text.startsWith('UPDATE'))!
    expect(upd.text).not.toMatch(/base = /)
  })

  it('update() bumps the version via optimistic UPDATE ... WHERE id AND version', async () => {
    const { db, calls } = fakeDb([
      { match: s => s.startsWith('UPDATE'), rows: () => [dbRow({ status: 'building', version: 1 })] },
    ])
    const next = await new PgSessionStore(db).update('s1', { status: 'building' }, 0)
    expect(next.version).toBe(1)
    expect(next.status).toBe('building')
    const upd = calls.find(c => c.text.startsWith('UPDATE'))!
    // version locking + bump.
    expect(upd.text).toMatch(/WHERE id = \$\d+ AND version = \$\d+/)
    expect(upd.text).toMatch(/version = version \+ 1/)
  })

  it('GATE: update() SET clause is built from a fixed allowlist and NEVER writes approval/verify_token, even with a polluted patch', async () => {
    const { db, calls } = fakeDb([
      { match: s => s.startsWith('UPDATE'), rows: () => [dbRow({ status: 'building', version: 1 })] },
    ])
    // A maliciously-shaped patch attempting to slip gate columns through update().
    const polluted = { status: 'building', approval: { forged: true }, verifyToken: { forged: true }, verify_token: { forged: true } } as never
    await new PgSessionStore(db).update('s1', polluted, 0)
    const upd = calls.find(c => c.text.startsWith('UPDATE'))!
    expect(upd.text).not.toMatch(/approval/i)
    expect(upd.text).not.toMatch(/verify_token/i)
    // and the forged values never reach the params either.
    expect(JSON.stringify(upd.params)).not.toMatch(/forged/)
  })

  it('ADDITIVE: update() WRITES the NON-GATE test_evidence column but the SAME patch still rejects gate columns (allowlist not widened)', async () => {
    const { db, calls } = fakeDb([
      { match: s => s.startsWith('UPDATE'), rows: () => [dbRow({ status: 'building', version: 1, test_evidence: { testsRun: 1 } })] },
    ])
    const evidence = { testsRun: 1, passed: true, durationMs: 5, bdd: { built: 1, run: 1, passed: 1, failed: 0, skipped: 0, durationMs: 5 }, e2e: { testsRun: 0, passed: false, expected: 0, unexpected: 0, flaky: 0, skipped: 0, durationMs: 0 }, scenarios: [{ name: 'x', suite: 'bdd' as const, passed: true }] }
    // Pollute the SAME patch with gate columns alongside the legit testEvidence.
    const patch = { status: 'building', testEvidence: evidence, approval: { forged: true }, verifyToken: { forged: true } } as never
    await new PgSessionStore(db).update('s1', patch, 0)
    const upd = calls.find(c => c.text.startsWith('UPDATE'))!
    // test_evidence IS in the SET clause (additive, non-gate)…
    expect(upd.text).toMatch(/test_evidence = /)
    expect(JSON.stringify(upd.params)).toMatch(/testsRun/)
    // …but the gate columns are STILL never written and the forged values never reach params.
    expect(upd.text).not.toMatch(/approval/i)
    expect(upd.text).not.toMatch(/verify_token/i)
    expect(JSON.stringify(upd.params)).not.toMatch(/forged/)
  })

  it('update() throws a `version conflict` error matching MockSessionStore when the optimistic UPDATE matches no row', async () => {
    const { db } = fakeDb([
      { match: s => s.startsWith('UPDATE'), rows: () => [] },                       // no row updated
      { match: s => s.startsWith('SELECT'), rows: () => [dbRow({ version: 5 })] },   // current version is 5
    ])
    await expect(new PgSessionStore(db).update('s1', { status: 'building' }, 2))
      .rejects.toThrow(/version conflict: 5 !== 2/)
  })

  it('recordApproval persists the approval jsonb (and only via this method) with version locking', async () => {
    const approval = { spec: { title: 'T', body: 'B' }, specDigest: 'd' } as unknown as ApprovalToken
    const { db, calls } = fakeDb([
      { match: s => s.startsWith('UPDATE'), rows: () => [dbRow({ approval, version: 1 })] },
    ])
    const next = await new PgSessionStore(db).recordApproval('s1', approval, 0)
    expect(next.version).toBe(1)
    expect(next.approval).toEqual(approval)
    const upd = calls.find(c => c.text.startsWith('UPDATE'))!
    expect(upd.text).toMatch(/approval = /)
    expect(upd.text).toMatch(/WHERE id = \$\d+ AND version = \$\d+/)
  })

  it('recordVerification persists a branded VerifyToken that survives the round-trip so isVerified() holds after get()', async () => {
    const token = { sessionId: 's1', testsRun: 2, codeDigest: 'cd' } as unknown as VerifyToken
    // recordVerification UPDATEs; a later get() reads it back from jsonb.
    const { db } = fakeDb([
      { match: s => s.startsWith('UPDATE'), rows: () => [dbRow({ verify_token: token, version: 1 })] },
      { match: s => s.startsWith('SELECT'), rows: () => [dbRow({ verify_token: token, version: 1 })] },
    ])
    const store = new PgSessionStore(db)
    const recorded = await store.recordVerification('s1', token, 0)
    expect(isVerified(recorded)).toBe(true)
    const reread = await store.get('s1')
    expect(reread).toBeDefined()
    expect(isVerified(reread!)).toBe(true)
  })

  it('listByOwner queries newest-first (owner filter + DESC) and maps every row', async () => {
    const { db, calls } = fakeDb([
      { match: s => s.startsWith('SELECT'), rows: () => [dbRow({ id: 'b', version: 2 }), dbRow({ id: 'a', version: 1 })] },
    ])
    const list = await new PgSessionStore(db).listByOwner('u1')
    expect(list.map(s => s.id)).toEqual(['b', 'a'])
    const sel = calls.find(c => c.text.startsWith('SELECT'))!
    expect(sel.text).toMatch(/owner_id = \$1/)
    expect(sel.text).toMatch(/ORDER BY .*DESC/i)
    expect(sel.params).toEqual(['u1'])
  })
})
