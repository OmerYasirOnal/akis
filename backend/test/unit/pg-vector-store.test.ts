import { describe, it, expect } from 'vitest'
import { PgVectorStore } from '../../src/knowledge/store/PgVectorStore.js'
import type { StoredChunk, ChunkMeta } from '../../src/knowledge/store/VectorStore.js'
import type { SqlClient } from '../../src/store/pg.js'

/** A fake SqlClient: records every query and returns scripted rows by a matcher. */
function fakeDb(handlers: { match: (sql: string) => boolean; rows: (params: unknown[]) => Array<Record<string, unknown>> }[] = []) {
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

let counter = 0
function stored(o: Partial<{ id: string; userId: string; sessionId: string; source: string; sourceId: string; agent: string; vector: number[]; text: string }> = {}): StoredChunk {
  const id = o.id ?? `c${counter++}`
  const meta: ChunkMeta = {
    source: o.source ?? 'upload',
    sourceId: o.sourceId ?? 'doc.md',
    userId: o.userId ?? 'u1',
    sessionId: o.sessionId ?? 's1',
    createdAt: '2026-06-01T00:00:00Z',
    ...(o.agent !== undefined ? { agent: o.agent } : {}),
  }
  return {
    id,
    vector: o.vector ?? [0.1, 0.2, 0.3],
    chunk: { id, text: o.text ?? 'hello world', source: `${meta.source}:${meta.sourceId}`, score: 0 },
    meta,
  }
}

describe('PgVectorStore (write-through to an injected SqlClient)', () => {
  it('upsert persists id, tenancy columns, the vector array and the chunk/meta payloads (idempotent ON CONFLICT)', async () => {
    const { db, calls } = fakeDb()
    const store = new PgVectorStore(db)
    store.upsert(stored({ id: 'k1', userId: 'u9', sessionId: 'sess', source: 'repo', sourceId: 'a/b.ts', agent: 'scribe', vector: [1, 2, 3] }))
    await store.flush()
    const ins = calls.find(c => c.text.trim().startsWith('INSERT INTO vector_chunks'))!
    expect(ins).toBeDefined()
    expect(ins.text).toMatch(/ON CONFLICT \(id\) DO UPDATE/i)
    // positional params: id, user_id, session_id, source, source_id, agent, created_at, vector, chunk, meta
    expect(ins.params[0]).toBe('k1')
    expect(ins.params[1]).toBe('u9')
    expect(ins.params[2]).toBe('sess')
    expect(ins.params[3]).toBe('repo')
    expect(ins.params[4]).toBe('a/b.ts')
    expect(ins.params[5]).toBe('scribe')
    expect(ins.params[7]).toEqual([1, 2, 3]) // the embedding as a Postgres array param
  })

  it('upsert with no agent persists NULL for the agent column (exactOptionalPropertyTypes-safe)', async () => {
    const { db, calls } = fakeDb()
    const store = new PgVectorStore(db)
    store.upsert(stored({ id: 'noagent' }))
    await store.flush()
    const ins = calls.find(c => c.text.trim().startsWith('INSERT INTO vector_chunks'))!
    expect(ins.params[5]).toBeNull()
  })

  it('deleteBy evaluates the predicate over the in-memory index then issues a single DELETE … WHERE id = ANY($1)', async () => {
    const { db, calls } = fakeDb()
    const store = new PgVectorStore(db)
    store.upsert(stored({ id: 'del1', sessionId: 'gone' }))
    store.upsert(stored({ id: 'del2', sessionId: 'gone' }))
    store.upsert(stored({ id: 'keep', sessionId: 'stay' }))
    await store.flush()
    calls.length = 0
    const n = store.deleteBy(m => m.sessionId === 'gone')
    expect(n).toBe(2)
    await store.flush()
    const del = calls.find(c => c.text.trim().startsWith('DELETE FROM vector_chunks'))!
    expect(del).toBeDefined()
    expect(del.text).toMatch(/WHERE id = ANY\(\$1\)/)
    expect((del.params[0] as string[]).sort()).toEqual(['del1', 'del2'])
  })

  it('deleteBy matching nothing issues NO DELETE (idempotent, no-op)', async () => {
    const { db, calls } = fakeDb()
    const store = new PgVectorStore(db)
    store.upsert(stored({ id: 'x', sessionId: 'stay' }))
    await store.flush()
    calls.length = 0
    expect(store.deleteBy(m => m.sessionId === 'never')).toBe(0)
    await store.flush()
    expect(calls.some(c => c.text.trim().startsWith('DELETE'))).toBe(false)
  })

  it('hydrate() rebuilds the in-memory index from a SELECT scan so the corpus survives restart', async () => {
    const { db } = fakeDb([
      {
        match: s => /SELECT .* FROM vector_chunks/.test(s),
        rows: () => [
          {
            id: 'r1', vector: [1, 0, 0],
            chunk: { id: 'r1', text: 'persisted text', source: 'upload:doc.md', score: 0 },
            meta: { source: 'upload', sourceId: 'doc.md', userId: 'u1', sessionId: 's1', createdAt: '2026-06-01T00:00:00Z' },
          },
        ],
      },
    ])
    const store = new PgVectorStore(db)
    await store.hydrate()
    expect(store.size()).toBe(1)
    expect(store.has('r1')).toBe(true)
    const res = store.search([1, 0, 0], { userId: 'u1' }, 5)
    expect(res[0]!.stored.chunk.text).toBe('persisted text')
  })

  it('hydrate() coerces a jsonb-stringified vector/payload (driver round-trip variance) into the StoredChunk shape', async () => {
    // A `double precision[]` comes back as a JS number[]; jsonb columns come back parsed.
    // But guard against a driver/serializer returning the vector as a JSON string too.
    const { db } = fakeDb([
      {
        match: s => /SELECT .* FROM vector_chunks/.test(s),
        rows: () => [
          {
            id: 'r2', vector: '[0,1,0]',
            chunk: JSON.stringify({ id: 'r2', text: 'stringified', source: 'upload:d', score: 0 }),
            meta: JSON.stringify({ source: 'upload', sourceId: 'd', userId: 'u1', sessionId: 's1', createdAt: 't' }),
          },
        ],
      },
    ])
    const store = new PgVectorStore(db)
    await store.hydrate()
    const res = store.search([0, 1, 0], { userId: 'u1' }, 5)
    expect(res[0]!.stored.chunk.text).toBe('stringified')
    expect(res[0]!.score).toBeCloseTo(1, 6) // cosine of identical unit vectors
  })
})
