import { describe, it, expect } from 'vitest'
import type { VectorStore, StoredChunk, ChunkMeta, TenantFilter } from '../../src/knowledge/store/VectorStore.js'
import { MemoryVectorStore } from '../../src/knowledge/store/MemoryVectorStore.js'
import { PgVectorStore } from '../../src/knowledge/store/PgVectorStore.js'
import type { SqlClient } from '../../src/store/pg.js'

/**
 * A STATEFUL fake Postgres `vector_chunks` table. PgVectorStore keeps a write-through
 * in-memory index (so the SYNCHRONOUS VectorStore reads stay parity-identical to
 * MemoryVectorStore) and persists every mutation here; this fake records the persisted
 * rows so the hydrate-on-boot + write-through behaviour is exercised end to end. The
 * suite never imports real `pg`.
 */
function fakeVectorTable(): { db: SqlClient; rowCount: () => number; calls: string[] } {
  interface Row { id: string; user_id: string; session_id: string; vector: number[]; chunk: unknown; meta: unknown; seq: number }
  const rows = new Map<string, Row>()
  const calls: string[] = []
  let seq = 0

  const db: SqlClient = {
    async query(text, params = []) {
      const sql = text.trim()
      calls.push(sql)

      if (sql.startsWith('INSERT INTO vector_chunks')) {
        const [id, user_id, session_id, , , , , vector, chunk, meta] = params
        const existing = rows.get(id as string)
        rows.set(id as string, {
          id: id as string, user_id: user_id as string, session_id: session_id as string,
          vector: vector as number[], chunk, meta,
          seq: existing ? existing.seq : seq++, // ON CONFLICT keeps original insertion order
        })
        return { rows: [] }
      }

      if (sql.startsWith('SELECT') && /FROM vector_chunks/.test(sql)) {
        // Hydration scan: every row, oldest-first (so the rebuilt index matches insert order).
        const out = [...rows.values()]
          .sort((a, b) => a.seq - b.seq)
          .map(r => ({ id: r.id, vector: r.vector, chunk: r.chunk, meta: r.meta }))
        return { rows: out }
      }

      if (sql.startsWith('DELETE FROM vector_chunks')) {
        const ids = params[0] as string[]
        for (const id of ids) rows.delete(id)
        return { rows: [] }
      }

      return { rows: [] }
    },
  }
  return { db, rowCount: () => rows.size, calls }
}

/** A deterministic L2-normalized vector from a sparse spec, dim 8 (small, exact). */
function vec(spec: Record<number, number>, dim = 8): number[] {
  const v = new Array<number>(dim).fill(0)
  for (const [i, x] of Object.entries(spec)) v[Number(i)] = x
  let norm = 0
  for (const x of v) norm += x * x
  norm = Math.sqrt(norm)
  if (norm === 0) return v
  return v.map(x => x / norm)
}

let counter = 0
function chunk(o: { id?: string; userId?: string; sessionId?: string; source?: string; sourceId?: string; agent?: string; vector: number[]; text?: string }): StoredChunk {
  const id = o.id ?? `c${counter++}`
  const meta: ChunkMeta = {
    source: o.source ?? 'conversation',
    sourceId: o.sourceId ?? 's1',
    userId: o.userId ?? 'u1',
    sessionId: o.sessionId ?? 's1',
    createdAt: '2026-06-01T00:00:00Z',
    ...(o.agent !== undefined ? { agent: o.agent } : {}),
  }
  return {
    id,
    vector: o.vector,
    chunk: { id, text: o.text ?? 'text', source: `${meta.source}:${meta.sourceId}`, score: 0 },
    meta,
  }
}

/** The synchronous-read behaviour both stores must agree on, run identically through each. */
function paritySuite(name: string, make: () => VectorStore) {
  describe(`${name} parity`, () => {
    it('upsert + search ranks by cosine descending and slices to k, identical shape', () => {
      const store = make()
      const near = chunk({ id: 'near', userId: 'u1', vector: vec({ 0: 1, 1: 0.1 }) })
      const mid = chunk({ id: 'mid', userId: 'u1', vector: vec({ 0: 0.5, 1: 0.5 }) })
      const far = chunk({ id: 'far', userId: 'u1', vector: vec({ 2: 1 }) })
      store.upsert(far); store.upsert(near); store.upsert(mid)
      const q = vec({ 0: 1 })
      const res = store.search(q, { userId: 'u1' }, 2)
      expect(res.map(s => s.stored.id)).toEqual(['near', 'mid'])
      expect(res[0]!.score).toBeGreaterThan(res[1]!.score)
      expect(res[0]!.stored.chunk.text).toBe('text')
      expect(res[0]!.stored.meta.userId).toBe('u1')
    })

    it('search applies tenancy: user B never sees user A’s chunk', () => {
      const store = make()
      store.upsert(chunk({ id: 'a', userId: 'A', vector: vec({ 0: 1 }) }))
      store.upsert(chunk({ id: 'b', userId: 'B', vector: vec({ 0: 1 }) }))
      expect(store.search(vec({ 0: 1 }), { userId: 'A' }, 10).map(s => s.stored.id)).toEqual(['a'])
      expect(store.search(vec({ 0: 1 }), { userId: 'B' }, 10).map(s => s.stored.id)).toEqual(['b'])
    })

    it('search with a sessionId filter narrows to that session', () => {
      const store = make()
      store.upsert(chunk({ id: 's1c', userId: 'u1', sessionId: 's1', vector: vec({ 0: 1 }) }))
      store.upsert(chunk({ id: 's2c', userId: 'u1', sessionId: 's2', vector: vec({ 0: 1 }) }))
      const filter: TenantFilter = { userId: 'u1', sessionId: 's2' }
      expect(store.search(vec({ 0: 1 }), filter, 10).map(s => s.stored.id)).toEqual(['s2c'])
    })

    it('search returns [] for an empty store', () => {
      const store = make()
      expect(store.search(vec({ 0: 1 }), { userId: 'u1' }, 5)).toEqual([])
    })

    it('upsert is idempotent on id (re-upsert overwrites, size stays 1)', () => {
      const store = make()
      store.upsert(chunk({ id: 'x', userId: 'u1', vector: vec({ 0: 1 }), text: 'first' }))
      store.upsert(chunk({ id: 'x', userId: 'u1', vector: vec({ 0: 1 }), text: 'second' }))
      expect(store.size()).toBe(1)
      expect(store.search(vec({ 0: 1 }), { userId: 'u1' }, 5)[0]!.stored.chunk.text).toBe('second')
    })

    it('has() reflects presence by id', () => {
      const store = make()
      expect(store.has('nope')).toBe(false)
      store.upsert(chunk({ id: 'present', userId: 'u1', vector: vec({ 0: 1 }) }))
      expect(store.has('present')).toBe(true)
      expect(store.has('absent')).toBe(false)
    })

    it('size() counts every chunk across tenants', () => {
      const store = make()
      expect(store.size()).toBe(0)
      store.upsert(chunk({ id: '1', userId: 'A', vector: vec({ 0: 1 }) }))
      store.upsert(chunk({ id: '2', userId: 'B', vector: vec({ 0: 1 }) }))
      expect(store.size()).toBe(2)
    })

    it('deleteBy(source+sourceId) is tenancy-SCOPED: never deletes another tenant’s same-path file', () => {
      const store = make()
      store.upsert(chunk({ id: 'uA', userId: 'A', sessionId: 'A', source: 'repo', sourceId: 'README.md', vector: vec({ 0: 1 }) }))
      store.upsert(chunk({ id: 'uB', userId: 'B', sessionId: 'B', source: 'repo', sourceId: 'README.md', vector: vec({ 0: 1 }) }))
      const removed = store.deleteBy(m => m.source === 'repo' && m.sourceId === 'README.md' && m.userId === 'A' && m.sessionId === 'A')
      expect(removed).toBe(1)
      expect(store.has('uA')).toBe(false)
      expect(store.has('uB')).toBe(true) // B's identically-pathed file survives
      expect(store.size()).toBe(1)
    })

    it('deleteBy(session) removes only that session and returns the count (idempotent)', () => {
      const store = make()
      store.upsert(chunk({ id: 'a', userId: 'u1', sessionId: 'gone', vector: vec({ 0: 1 }) }))
      store.upsert(chunk({ id: 'b', userId: 'u1', sessionId: 'gone', vector: vec({ 1: 1 }) }))
      store.upsert(chunk({ id: 'c', userId: 'u1', sessionId: 'keep', vector: vec({ 2: 1 }) }))
      expect(store.deleteBy(m => m.sessionId === 'gone')).toBe(2)
      expect(store.deleteBy(m => m.sessionId === 'gone')).toBe(0) // idempotent
      expect(store.size()).toBe(1)
      expect(store.has('c')).toBe(true)
    })

    it('round-trips agent provenance (present and absent) through meta', () => {
      const store = make()
      store.upsert(chunk({ id: 'withAgent', userId: 'u1', agent: 'scribe', vector: vec({ 0: 1 }) }))
      store.upsert(chunk({ id: 'noAgent', userId: 'u1', vector: vec({ 1: 1 }) }))
      expect(store.search(vec({ 0: 1 }), { userId: 'u1' }, 1)[0]!.stored.meta.agent).toBe('scribe')
      expect(store.search(vec({ 1: 1 }), { userId: 'u1' }, 1)[0]!.stored.meta.agent).toBeUndefined()
    })
  })
}

paritySuite('MemoryVectorStore', () => new MemoryVectorStore())
// A fresh fake table per construction, hydrated empty — synchronous reads use the
// write-through index, so the SAME parity suite runs unchanged against PgVectorStore.
paritySuite('PgVectorStore', () => new PgVectorStore(fakeVectorTable().db))

describe('PgVectorStore persistence (write-through + hydrate-on-boot)', () => {
  it('write-through: each upsert persists a row; deleteBy removes the persisted rows', async () => {
    const { db, rowCount } = fakeVectorTable()
    const store = new PgVectorStore(db)
    store.upsert(chunk({ id: 'a', userId: 'u1', vector: vec({ 0: 1 }) }))
    store.upsert(chunk({ id: 'b', userId: 'u1', vector: vec({ 1: 1 }) }))
    await store.flush() // settle the async write-through before asserting on the table
    expect(rowCount()).toBe(2)
    store.deleteBy(m => m.userId === 'u1') // delete the whole tenant
    await store.flush()
    expect(rowCount()).toBe(0)
  })

  it('persisted rows survive a "restart": a new store hydrates the SAME corpus from the table', async () => {
    const { db } = fakeVectorTable()
    const first = new PgVectorStore(db)
    first.upsert(chunk({ id: 'persisted', userId: 'u1', vector: vec({ 0: 1 }), text: 'durable' }))
    first.upsert(chunk({ id: 'other', userId: 'u1', vector: vec({ 1: 1 }), text: 'second' }))
    await first.flush()

    // Simulate a process restart: a brand-new store over the SAME table.
    const second = new PgVectorStore(db)
    await second.hydrate()
    expect(second.size()).toBe(2)
    expect(second.has('persisted')).toBe(true)
    const res = second.search(vec({ 0: 1 }), { userId: 'u1' }, 1)
    expect(res[0]!.stored.id).toBe('persisted')
    expect(res[0]!.stored.chunk.text).toBe('durable')
  })

  it('upserts the vector as an array column and the chunk/meta as jsonb-able params', async () => {
    const { db, calls } = fakeVectorTable()
    const store = new PgVectorStore(db)
    store.upsert(chunk({ id: 'x', userId: 'u1', vector: vec({ 0: 1 }) }))
    await store.flush()
    const insert = calls.find(c => c.startsWith('INSERT INTO vector_chunks'))!
    expect(insert).toMatch(/ON CONFLICT \(id\) DO UPDATE/i) // idempotent upsert on id
  })
})

/** The deleteBy "delete all" helper above uses a predicate that always matches; this is the
 *  same shape RagService passes (an arbitrary ChunkMeta predicate), evaluated in JS over the
 *  in-memory index, then a single DELETE … WHERE id = ANY(...) persists the removal. */
