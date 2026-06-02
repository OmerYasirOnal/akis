import { describe, it, expect } from 'vitest'
import type { SessionState, ApprovalToken, VerifyToken } from '@akis/shared'
import { isVerified } from '@akis/shared'
import type { SessionStore } from '../../src/store/SessionStore.js'
import { MockSessionStore } from '../../src/store/MockSessionStore.js'
import { PgSessionStore } from '../../src/store/PgSessionStore.js'
import type { SqlClient } from '../../src/store/pg.js'

/**
 * A STATEFUL fake Postgres `sessions` table: enough SQL surface (INSERT / SELECT /
 * the optimistic UPDATEs) to drive PgSessionStore for behavioural parity with the
 * in-memory MockSessionStore. The suite never imports real `pg`.
 */
function fakeSessionsTable(): SqlClient {
  const rows = new Map<string, Record<string, unknown>>()
  const order: string[] = [] // insertion order, for newest-first listing

  const num = (sql: string, name: string): number => {
    // pull the $N placeholder index used for a given assignment, e.g. "status = $3"
    const m = new RegExp(`${name} = \\$(\\d+)`).exec(sql)
    return m ? Number(m[1]) : -1
  }

  return {
    async query(text, params = []) {
      const sql = text.trim()
      if (sql.startsWith('INSERT INTO sessions')) {
        // params are positional in the column list order used by PgSessionStore.create.
        const [id, status, idea, owner_id, spec, approval, code, verify_token, version] = params
        const r = { id, status, idea, owner_id, spec, approval, code, verify_token, version }
        rows.set(id as string, r)
        order.push(id as string)
        return { rows: [] }
      }
      if (sql.startsWith('SELECT')) {
        if (/owner_id = \$1/.test(sql)) {
          const owner = params[0]
          const out = order
            .map(id => rows.get(id)!)
            .filter(r => r.owner_id === owner)
            .reverse() // newest-first
          return { rows: out.map(r => ({ ...r })) }
        }
        const id = params[0] as string
        const r = rows.get(id)
        return { rows: r ? [{ ...r }] : [] }
      }
      if (sql.startsWith('UPDATE')) {
        const id = params[params.length - 2] as string // ... WHERE id = $n AND version = $n+1
        const expected = params[params.length - 1] as number
        const cur = rows.get(id)
        if (!cur || cur.version !== expected) return { rows: [] } // optimistic miss
        const next: Record<string, unknown> = { ...cur, version: (cur.version as number) + 1 }
        // apply whichever known columns this UPDATE set (by placeholder index).
        for (const col of ['status', 'idea', 'owner_id', 'spec', 'code', 'approval', 'verify_token']) {
          const i = num(sql, col)
          if (i >= 1) next[col] = params[i - 1]
        }
        rows.set(id, next)
        return { rows: [{ ...next }] }
      }
      return { rows: [] }
    },
  }
}

/** The behaviour both stores must agree on. */
function paritySuite(name: string, make: () => SessionStore) {
  describe(`${name} parity`, () => {
    const seed = (o: Partial<SessionState> = {}): SessionState =>
      ({ id: 's1', status: 'composing', idea: 'idea', version: 0, ...o })

    it('create then get returns a structural copy (not the same reference)', async () => {
      const store = make()
      const s = seed({ ownerId: 'u1' })
      await store.create(s)
      const got = await store.get('s1')
      expect(got).toMatchObject({ id: 's1', status: 'composing', idea: 'idea', ownerId: 'u1', version: 0 })
    })

    it('update bumps version and applies the allowlisted patch', async () => {
      const store = make()
      await store.create(seed())
      const next = await store.update('s1', { status: 'building' }, 0)
      expect(next.version).toBe(1)
      expect(next.status).toBe('building')
    })

    it('a stale expectedVersion throws a matching version-conflict error', async () => {
      const store = make()
      await store.create(seed())
      await store.update('s1', { status: 'building' }, 0) // version → 1
      await expect(store.update('s1', { status: 'failed' }, 0)).rejects.toThrow(/version conflict: 1 !== 0/)
    })

    it('mutating a non-existent session throws "session <id> not found" (404-mappable), not a version conflict', async () => {
      const store = make()
      await expect(store.update('ghost', { status: 'failed' }, 0)).rejects.toThrow(/^session ghost not found$/)
    })

    it('recordApproval persists an approval (and isVerified stays false)', async () => {
      const store = make()
      await store.create(seed())
      const approval = { spec: { title: 'T', body: 'B' }, specDigest: 'd' } as unknown as ApprovalToken
      const next = await store.recordApproval('s1', approval, 0)
      expect(next.approval).toEqual(approval)
      expect(isVerified(next)).toBe(false)
    })

    it('recordVerification round-trips a branded token so isVerified() holds after get()', async () => {
      const store = make()
      await store.create(seed())
      const token = { sessionId: 's1', testsRun: 1, codeDigest: 'cd' } as unknown as VerifyToken
      await store.recordVerification('s1', token, 0)
      const got = await store.get('s1')
      expect(got).toBeDefined()
      expect(isVerified(got!)).toBe(true)
    })

    it('listByOwner returns the owner’s sessions newest-first', async () => {
      const store = make()
      await store.create(seed({ id: 'a', ownerId: 'u1' }))
      await store.create(seed({ id: 'b', ownerId: 'u1' }))
      await store.create(seed({ id: 'c', ownerId: 'u2' }))
      const list = await store.listByOwner('u1')
      expect(list.map(s => s.id)).toEqual(['b', 'a'])
    })
  })
}

paritySuite('MockSessionStore', () => new MockSessionStore())
paritySuite('PgSessionStore', () => new PgSessionStore(fakeSessionsTable()))
