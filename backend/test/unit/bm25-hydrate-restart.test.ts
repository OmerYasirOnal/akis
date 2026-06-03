import { describe, it, expect } from 'vitest'
import { buildRag } from '../../src/knowledge/buildRag.js'
import { Bm25Index } from '../../src/knowledge/store/Bm25Index.js'
import { PgVectorStore } from '../../src/knowledge/store/PgVectorStore.js'
import { EventBus } from '../../src/events/bus.js'
import type { SqlClient } from '../../src/store/pg.js'

const noBackoff = { backoffMs: () => 0 }
const fixedNow = (): string => '2026-06-01T00:00:00Z'

/**
 * A fake durable backing for `vector_chunks`: an INSERT … ON CONFLICT upsert keyed by id and a
 * `SELECT … ORDER BY seq` scan that returns the rows in INSERTION order (mirroring the bigserial
 * seq). DELETE … WHERE id = ANY($1) prunes. This is the same row-shape PgVectorStore persists, so
 * one fake backs BOTH the vector store's hydrate AND the BM25 hydrate (they read the same rows).
 */
function fakeVectorChunksDb() {
  const rows = new Map<string, Record<string, unknown>>()
  let seq = 0
  const db: SqlClient = {
    async query(text, params = []) {
      const sql = text.trim()
      if (sql.startsWith('INSERT INTO vector_chunks')) {
        const [id, user_id, session_id, source, source_id, agent, created_at, vector, chunk, meta] = params as unknown[]
        const existing = rows.get(id as string)
        rows.set(id as string, {
          id, user_id, session_id, source, source_id, agent, created_at, vector, chunk, meta,
          seq: existing ? (existing.seq as number) : seq++,
        })
        return { rows: [] }
      }
      if (sql.startsWith('DELETE FROM vector_chunks')) {
        for (const id of (params[0] as string[]) ?? []) rows.delete(id)
        return { rows: [] }
      }
      if (/^SELECT .* FROM vector_chunks/.test(sql)) {
        const ordered = [...rows.values()].sort((a, b) => (a.seq as number) - (b.seq as number))
        return { rows: ordered.map(r => ({ id: r.id, vector: r.vector, chunk: r.chunk, meta: r.meta })) }
      }
      return { rows: [] }
    },
  }
  return { db }
}

/** A vivid corpus where lexical (exact-term) and semantic recall both matter — so a BM25 that
 *  did NOT survive restart would visibly lose hits the post-restart query expects. */
const CORPUS: Array<{ text: string; sourceId: string }> = [
  { text: 'postgres database migrations and idempotent schema design', sourceId: 'd1' },
  { text: 'reciprocal rank fusion blends lexical bm25 with vector cosine retrieval', sourceId: 'd2' },
  { text: 'the pgvector extension stores embeddings as a typed vector column', sourceId: 'd3' },
  { text: 'graceful shutdown drains the ingest queue before closing the pool', sourceId: 'd4' },
  { text: 'tenancy isolation keeps one user corpus invisible to another user', sourceId: 'd5' },
]

const USER = 'u1'
const SESSION = 's1'

async function seed(stack: ReturnType<typeof buildRag>): Promise<void> {
  for (const c of CORPUS) {
    stack.service.ingest({ text: c.text, source: 'upload', sourceId: c.sourceId, userId: USER, sessionId: SESSION })
  }
  await stack.queue.drain()
}

const QUERIES = ['pgvector embeddings vector column', 'bm25 lexical fusion', 'database migrations schema']

describe('BM25 + vector survive a simulated restart via Postgres hydration (the must-have)', () => {
  it('a NEW store + NEW Bm25Index hydrated from the same durable rows return identical vector AND lexical top-k', async () => {
    const { db } = fakeVectorChunksDb()

    // ── Boot 1: a Pg-backed stack ingests the corpus (write-through to the fake DB). ──
    const vec1 = new PgVectorStore(db)
    const bm1 = new Bm25Index()
    const before = buildRag({ bus: new EventBus(), queue: noBackoff, now: fixedNow, vectorStore: vec1, bm25: bm1 })
    await seed(before)
    await vec1.flush()

    const beforeResults = await Promise.all(QUERIES.map(q => before.service.retrieve(q, { userId: USER }, 4, false)))

    // ── Simulated restart: a BRAND-NEW vector store AND a BRAND-NEW BM25 index, hydrated ──
    // from the SAME durable rows — NOT re-ingested. This is exactly the boot path: the corpus
    // is reconstructed from Postgres, lexical half included.
    const vec2 = new PgVectorStore(db)
    await vec2.hydrate()
    const bm2 = new Bm25Index()
    bm2.hydrate(vec2.hydratedChunks())
    expect(bm2.size()).toBe(vec2.size())
    expect(bm2.size()).toBe(CORPUS.length)

    const after = buildRag({ bus: new EventBus(), queue: noBackoff, now: fixedNow, vectorStore: vec2, bm25: bm2 })
    const afterResults = await Promise.all(QUERIES.map(q => after.service.retrieve(q, { userId: USER }, 4, false)))

    // Top-k (ids + scores) are IDENTICAL pre/post restart — proving both modalities rehydrated.
    for (let i = 0; i < QUERIES.length; i++) {
      const ids = (r: typeof beforeResults[number]): string[] => r.map(c => c.id)
      expect(ids(afterResults[i]!)).toEqual(ids(beforeResults[i]!))
      expect(afterResults[i]!.map(c => c.score)).toEqual(beforeResults[i]!.map(c => c.score))
      expect(afterResults[i]!.length).toBeGreaterThan(0) // a real, non-empty retrieval
    }
  })

  it('the BM25 lexical half ALONE is non-empty after restart (it does not silently rebuild empty)', async () => {
    const { db } = fakeVectorChunksDb()
    const vec1 = new PgVectorStore(db)
    const before = buildRag({ bus: new EventBus(), queue: noBackoff, now: fixedNow, vectorStore: vec1, bm25: new Bm25Index() })
    await seed(before)
    await vec1.flush()

    // Restart, hydrate BM25 from durable rows, then query BM25 DIRECTLY (not fused) — an
    // exact lexical term ('pgvector') the embedding alone might miss MUST still hit.
    const vec2 = new PgVectorStore(db)
    await vec2.hydrate()
    const bm2 = new Bm25Index()
    bm2.hydrate(vec2.hydratedChunks())
    const lex = bm2.search('pgvector', { userId: USER }, 5)
    expect(lex.length).toBeGreaterThan(0)
    expect(lex[0]!.stored.chunk.text).toContain('pgvector')
  })

  it('the default (no Pg) buildRag path is unchanged: a fresh in-memory Bm25Index, byte-for-byte', async () => {
    const stack = buildRag({ bus: new EventBus(), queue: noBackoff, now: fixedNow })
    // No corpus ingested → BM25 is empty (the in-memory default, lost on restart, unchanged).
    expect(stack.service.getMetrics().corpusSize).toBe(0)
    expect(await stack.service.retrieve('anything', { userId: USER }, 5)).toHaveLength(0)
  })
})
