import { describe, it, expect } from 'vitest'
import type { SessionState, ApprovalToken, VerifyToken, PublishRecord } from '@akis/shared'
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

  // FAITHFUL pg jsonb modelling: the store now hands pg JSON STRINGS for jsonb columns (toJson
  // stringifies — the chat-array fix), and real pg returns those columns already PARSED on read.
  // Mirror that here: parse the jsonb columns back to JS values on SELECT, so the round-trip the
  // parity suite asserts (write object/array → get() returns the same) reflects real pg behaviour.
  const JSONB = new Set(['spec', 'approval', 'code', 'verify_token', 'test_evidence', 'passport', 'publish', 'chat', 'base'])
  const hydrate = (r: Record<string, unknown>): Record<string, unknown> => {
    const out = { ...r }
    for (const c of JSONB) if (typeof out[c] === 'string') out[c] = JSON.parse(out[c] as string)
    return out
  }

  return {
    async query(text, params = []) {
      const sql = text.trim()
      if (sql.startsWith('INSERT INTO sessions')) {
        // params are positional in the column list order used by PgSessionStore.create.
        const [id, status, idea, owner_id, spec, approval, code, verify_token, test_evidence, passport, publish, chat, base, version] = params
        const r = { id, status, idea, owner_id, spec, approval, code, verify_token, test_evidence, passport, publish, chat, base, version }
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
          return { rows: out.map(r => hydrate(r)) }
        }
        const id = params[0] as string
        const r = rows.get(id)
        return { rows: r ? [hydrate(r)] : [] }
      }
      if (sql.startsWith('UPDATE')) {
        const id = params[params.length - 2] as string // ... WHERE id = $n AND version = $n+1
        const expected = params[params.length - 1] as number
        const cur = rows.get(id)
        if (!cur || cur.version !== expected) return { rows: [] } // optimistic miss
        const next: Record<string, unknown> = { ...cur, version: (cur.version as number) + 1 }
        // apply whichever known columns this UPDATE set (by placeholder index).
        for (const col of ['status', 'idea', 'owner_id', 'spec', 'code', 'approval', 'verify_token', 'test_evidence', 'passport', 'publish', 'chat']) {
          const i = num(sql, col)
          if (i >= 1) next[col] = params[i - 1]
        }
        rows.set(id, next)
        return { rows: [hydrate(next)] }
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

    it('listSummariesByOwner projects {id, idea, status, verified} with the REAL isVerified semantics', async () => {
      const store = make()
      await store.create(seed({ ownerId: 'u1' }))
      await store.create(seed({ id: 's2', idea: 'second', status: 'done', ownerId: 'u1' }))
      await store.create(seed({ id: 's3', ownerId: 'someone-else' }))
      // s2 genuinely verified; s1 carries a MISMATCHED token (token bound to another session id) —
      // the projection must NOT report it verified (the bare verify_token-IS-NOT-NULL trap).
      await store.recordVerification('s2', { sessionId: 's2', testsRun: 1, codeDigest: 'cd' } as unknown as VerifyToken, 0)
      await store.recordVerification('s1', { sessionId: 'NOT-s1', testsRun: 1, codeDigest: 'cd' } as unknown as VerifyToken, 0)
      const out = await store.listSummariesByOwner('u1')
      expect(out).toHaveLength(2)                      // owner-scoped (s3 excluded)
      expect(out[0]).toEqual({ id: 's2', idea: 'second', status: 'done', verified: true })  // newest first
      expect(out[1]).toEqual({ id: 's1', idea: 'idea', status: 'composing', verified: false }) // mismatched token ⇒ NOT verified
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

    it('persists ADDITIVE testEvidence on the NORMAL update path and round-trips it via get()', async () => {
      const store = make()
      await store.create(seed())
      const evidence = {
        testsRun: 2, passed: false, durationMs: 42,
        bdd: { built: 2, run: 2, passed: 1, failed: 1, skipped: 0, durationMs: 42 },
        e2e: { testsRun: 0, passed: false, expected: 0, unexpected: 0, flaky: 0, skipped: 0, durationMs: 0 },
        scenarios: [
          { name: 'logs in', suite: 'bdd' as const, passed: true },
          { name: 'logs out', suite: 'bdd' as const, passed: false, reason: 'FAILED', step: 'step reported FAILED' },
        ],
        failure: { failedCount: 1, scenarios: [{ name: 'logs out', suite: 'bdd' as const, passed: false, reason: 'FAILED', step: 'step reported FAILED' }] },
      }
      const next = await store.update('s1', { testEvidence: evidence }, 0)
      expect(next.version).toBe(1)
      const got = await store.get('s1')
      expect(got?.testEvidence).toEqual(evidence)
      // testEvidence is NON-GATE: writing it never sets a gate token.
      expect(isVerified(got!)).toBe(false)
      expect(got?.approval).toBeUndefined()
    })

    it('persists ADDITIVE passport on the NORMAL update path and round-trips it via get() (durable on Pg too)', async () => {
      const store = make()
      await store.create(seed())
      const passport = {
        v: 1 as const, sessionId: 's1', testsRun: 2, codeDigest: 'cd', evidenceDigest: 'ed',
        issuedAt: '2026-06-03T00:00:00.000Z', signature: 'sig', publicKey: 'pk',
      }
      const next = await store.update('s1', { passport }, 0)
      expect(next.version).toBe(1)
      const got = await store.get('s1')
      expect(got?.passport).toEqual(passport) // survives on the Pg backend, not just Mock (the fix-first finding)
      // passport is NON-GATE: writing it never sets a gate token.
      expect(isVerified(got!)).toBe(false)
      expect(got?.approval).toBeUndefined()
    })

    it('persists ADDITIVE chat turns on the NORMAL update path and round-trips them via get() (durable on Pg too)', async () => {
      const store = make()
      await store.create(seed())
      // The persisted conversation (the F5 fix): the FE rehydrates the thread from this, so it
      // must survive the Pg backend — a silently-dropped column would resurrect the lost-chat bug.
      const chat = [
        { role: 'user' as const, content: 'Neden testler geçmiyor?', at: '2026-06-06T08:00:00.000Z' },
        { role: 'assistant' as const, content: 'Doğrulama başarısız — 0 test üretildi.', at: '2026-06-06T08:00:05.000Z' },
      ]
      const next = await store.update('s1', { chat }, 0)
      expect(next.version).toBe(1)
      const got = await store.get('s1')
      expect(got?.chat).toEqual(chat)
      // chat is NON-GATE: writing it never sets a gate token.
      expect(isVerified(got!)).toBe(false)
      expect(got?.approval).toBeUndefined()
    })

    it('persists ADDITIVE publish on the NORMAL update path and round-trips it via get() (durable on Pg too)', async () => {
      const store = make()
      await store.create(seed())
      // A realistic PublishRecord: a successful-but-unreachable deploy (the OCI port-closed case),
      // which is EXACTLY the output the FE PublishButton must read back to show the live URL +
      // honest reachability. On Pg this was previously dropped entirely (the fix-first finding).
      const publish: PublishRecord = {
        url: 'http://203.0.113.10:8080',
        at: '2026-06-05T00:00:00.000Z',
        ok: true,
        reachable: false,
        appType: 'node-service',
        logTail: ['deploy ok', 'probe: connection refused (port not open)'],
      }
      const next = await store.update('s1', { publish }, 0)
      expect(next.version).toBe(1)
      expect(next.publish).toEqual(publish) // returned by the write itself
      const got = await store.get('s1')
      expect(got?.publish).toEqual(publish) // survives on the Pg backend, not just Mock
      // publish is NON-GATE: writing it never sets a gate token nor changes status off the patch.
      expect(isVerified(got!)).toBe(false)
      expect(got?.approval).toBeUndefined()
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
