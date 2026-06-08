import { describe, it, expect } from 'vitest'
import { type ExternalWriteRecord, type SessionState, EXTERNAL_WRITES_MAX, initialSession } from '@akis/shared'
import { MockSessionStore } from '../../src/store/MockSessionStore.js'
import type { SessionStore, SessionPatch } from '../../src/store/SessionStore.js'
import { appendExternalWrite } from '../../src/gates/appendExternalWrite.js'

/**
 * Regression tests for the SHARED status-aware appender (Bugs 1+2+3). The previous
 * `[...writes, rec].slice(-EXTERNAL_WRITES_MAX)` dropped index 0 STATUS-BLIND: a 51st propose
 * silently evicted a still-in-flight ('proposed'/'executing') record — losing a pending confirm's
 * outcome (bug 1/3) and, worse, the at-most-once ledger (a re-propose could double-execute). The
 * appender must NEVER evict a non-terminal record: it drops the OLDEST TERMINAL one, or REFUSES with
 * TooManyPending when every slot is non-terminal.
 */

const rec = (id: string, status: ExternalWriteRecord['status'], suffix = id): ExternalWriteRecord => ({
  id,
  provider: 'github',
  action: 'add_issue_comment',
  summary: `s-${id}`,
  // distinct content so nothing is a content-dedupe of another
  target: { owner: 'o', repo: 'r', issue_number: Number(suffix.replace(/\D/g, '') || '0') },
  payload: { body: `body-${suffix}` },
  status,
  proposedAt: '2026-06-08T00:00:00.000Z',
})

async function storeWith(writes: ExternalWriteRecord[]): Promise<MockSessionStore> {
  const store = new MockSessionStore()
  await store.create({ ...initialSession('s1', 'idea', 'owner-1') })
  // write the seed records via the normal update path (version 0 → 1)
  await store.update('s1', { externalWrites: writes }, 0)
  return store
}

describe('appendExternalWrite — status-aware capped append (Bugs 1+3)', () => {
  it('a 51st propose when the OLDEST record is in-flight does NOT evict it: it drops the oldest TERMINAL one instead', async () => {
    // 50 records: index 0 is 'executing' (in-flight), index 1 is 'executed' (terminal, oldest terminal),
    // the rest 'proposed'. A 51st append must keep index 0 and drop index 1.
    const seed: ExternalWriteRecord[] = []
    seed.push(rec('w0', 'executing'))
    seed.push(rec('w1', 'executed'))
    for (let i = 2; i < EXTERNAL_WRITES_MAX; i++) seed.push(rec(`w${i}`, 'proposed'))
    expect(seed).toHaveLength(EXTERNAL_WRITES_MAX)

    const store = await storeWith(seed)
    const out = await appendExternalWrite(store, 's1', rec('new', 'proposed'))
    expect(out).toEqual({ ok: true, id: 'new' })

    const ids = (await store.get('s1'))!.externalWrites!.map(w => w.id)
    expect(ids).toContain('w0')   // the in-flight 'executing' record SURVIVED (the bug evicted it)
    expect(ids).not.toContain('w1') // the oldest TERMINAL record was evicted to make room
    expect(ids).toContain('new')  // the new proposal landed
    expect(ids).toHaveLength(EXTERNAL_WRITES_MAX) // still capped
  })

  it('REFUSES with TooManyPending when the row is FULL of non-terminal records (never silently evicts one)', async () => {
    // All 50 'proposed' (none terminal) — there is nothing safe to evict, so the append is refused.
    const seed = Array.from({ length: EXTERNAL_WRITES_MAX }, (_, i) => rec(`p${i}`, 'proposed'))
    const store = await storeWith(seed)
    const out = await appendExternalWrite(store, 's1', rec('new', 'proposed'))
    expect(out).toEqual({ error: expect.any(String), code: 'TooManyPending' })
    const ids = (await store.get('s1'))!.externalWrites!.map(w => w.id)
    expect(ids).not.toContain('new') // nothing appended
    expect(ids).toHaveLength(EXTERNAL_WRITES_MAX) // and no in-flight record dropped
  })

  it('mix of executing + proposed (no terminal) is ALSO refused — an executing record is never evicted', async () => {
    const seed: ExternalWriteRecord[] = [rec('exec0', 'executing'), rec('exec1', 'executing')]
    for (let i = 2; i < EXTERNAL_WRITES_MAX; i++) seed.push(rec(`p${i}`, 'proposed'))
    const store = await storeWith(seed)
    const out = await appendExternalWrite(store, 's1', rec('new', 'proposed'))
    expect('code' in out && out.code).toBe('TooManyPending')
    expect((await store.get('s1'))!.externalWrites!.some(w => w.id === 'exec0')).toBe(true)
  })

  it('under capacity ⇒ a plain append, nothing evicted', async () => {
    const store = await storeWith([rec('a', 'proposed')])
    const out = await appendExternalWrite(store, 's1', rec('b', 'proposed'))
    expect(out).toEqual({ ok: true, id: 'b' })
    expect((await store.get('s1'))!.externalWrites!.map(w => w.id)).toEqual(['a', 'b'])
  })

  it('a vanished session returns an error, never throws', async () => {
    const store = new MockSessionStore()
    await store.create({ ...initialSession('s1', 'idea', 'owner-1') })
    const out = await appendExternalWrite(store, 'ghost', rec('x', 'proposed'))
    expect(out).toEqual({ error: expect.stringContaining('ghost') })
  })

  it('Bug 2: retries on a version conflict instead of throwing — a concurrent bump is absorbed', async () => {
    // A store whose FIRST update throws a version conflict (a concurrent propose bumped the version
    // between our read and write), then succeeds on the retried read. The bare slice-append used to let
    // this throw straight to a Fastify 500; the appender must retry and land the record.
    const inner = new MockSessionStore()
    await inner.create({ ...initialSession('s1', 'idea', 'owner-1') })
    let updates = 0
    const flaky: SessionStore = {
      create: (s: SessionState) => inner.create(s),
      get: (id: string) => inner.get(id),
      async update(id: string, patch: SessionPatch, expectedVersion: number) {
        updates++
        if (updates === 1) {
          // simulate a concurrent writer landing first: bump the real version, then reject ours
          await inner.update(id, {}, expectedVersion)
          throw new Error(`version conflict: ${expectedVersion + 1} !== ${expectedVersion}`)
        }
        return inner.update(id, patch, expectedVersion)
      },
      recordApproval: (...a: Parameters<SessionStore['recordApproval']>) => inner.recordApproval(...a),
      recordVerification: (...a: Parameters<SessionStore['recordVerification']>) => inner.recordVerification(...a),
      listByOwner: (o: string) => inner.listByOwner(o),
      listSummariesByOwner: (o: string) => inner.listSummariesByOwner(o),
    }
    const out = await appendExternalWrite(flaky, 's1', rec('new', 'proposed'))
    expect(out).toEqual({ ok: true, id: 'new' })
    expect(updates).toBeGreaterThanOrEqual(2) // it retried after the conflict
    expect((await inner.get('s1'))!.externalWrites!.map(w => w.id)).toEqual(['new'])
  })
})
