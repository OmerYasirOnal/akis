import { describe, it, expect } from 'vitest'
import { createPgPool, runMigrations, ensurePgVectorColumn } from '../../src/store/pg.js'
import { PgVectorStore } from '../../src/knowledge/store/PgVectorStore.js'
import { Bm25Index } from '../../src/knowledge/store/Bm25Index.js'
import type { StoredChunk } from '../../src/knowledge/store/VectorStore.js'

/**
 * REAL-Postgres migration integration test (the fake-client unit tests can only prove a
 * statement is ISSUED, never that the DDL is valid or that constraints actually hold
 * after migration — exactly the coverage gap that let the external_id-uniqueness
 * divergence go unnoticed). Gated on AKIS_TEST_DATABASE_URL so it runs in CI (a postgres
 * service) and is skipped locally where no throwaway DB is available.
 */
const url = process.env.AKIS_TEST_DATABASE_URL

describe.skipIf(!url)('runMigrations against real Postgres', () => {
  it('is idempotent and enforces external_id uniqueness while allowing multiple NULLs', async () => {
    const pool = await createPgPool(url!)
    try {
      // Deterministic slate: a real DB persists across runs.
      await pool.query('DROP TABLE IF EXISTS sessions, workflows, users CASCADE')

      await runMigrations(pool)
      await runMigrations(pool) // second run MUST NOT throw — every statement is idempotent

      // external_id is unique (the partial index works on a freshly migrated table).
      await pool.query("INSERT INTO users (id,name,email,password_hash,external_id) VALUES ('u1','A','a@x.dev','','gh:1')")
      await expect(
        pool.query("INSERT INTO users (id,name,email,password_hash,external_id) VALUES ('u2','B','b@x.dev','','gh:1')"),
      ).rejects.toMatchObject({ code: '23505' })

      // …but multiple password-only users (NULL external_id) are allowed (partial index).
      await pool.query("INSERT INTO users (id,name,email,password_hash) VALUES ('u3','C','c@x.dev','')")
      await pool.query("INSERT INTO users (id,name,email,password_hash) VALUES ('u4','D','d@x.dev','')")
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM users WHERE external_id IS NULL')
      expect(Number(rows[0]!.n)).toBe(2)
    } finally {
      if (pool.end) await pool.end()
    }
  })

  it('adds external_id uniqueness to a LEGACY users table that predates the column (the actual upgrade path)', async () => {
    const pool = await createPgPool(url!)
    try {
      await pool.query('DROP TABLE IF EXISTS sessions, workflows, users CASCADE')
      // A legacy users table from before external_id existed: the column — and thus its
      // inline UNIQUE — is ABSENT, so on this table only the CREATE_USERS_EXTERNAL_ID_UNIQUE
      // migration (not an inline constraint) can enforce identity uniqueness.
      await pool.query(`CREATE TABLE users (
        id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE,
        password_hash text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now())`)

      await runMigrations(pool) // CREATE TABLE no-ops; ADD COLUMN + the partial unique index apply

      await pool.query("INSERT INTO users (id,name,email,password_hash,external_id) VALUES ('u1','A','a@x.dev','','gh:1')")
      await expect(
        pool.query("INSERT INTO users (id,name,email,password_hash,external_id) VALUES ('u2','B','b@x.dev','','gh:1')"),
      ).rejects.toMatchObject({ code: '23505' }) // enforced by the migration's index, not an inline constraint
    } finally {
      if (pool.end) await pool.end()
    }
  })
})

/** REAL-Postgres PgVectorStore round-trip: persist a chunk, then prove a brand-new store
 *  HYDRATES the same corpus from the table (the durability guarantee — survives "restart"),
 *  that the `double precision[]` vector + jsonb payloads round-trip, that cosine ranking holds,
 *  and that a tenancy-scoped deleteBy persists. Gated on AKIS_TEST_DATABASE_URL like above. */
describe.skipIf(!url)('PgVectorStore against real Postgres', () => {
  const mkChunk = (o: { id: string; userId: string; sessionId?: string; source?: string; sourceId?: string; vector: number[]; text: string }): StoredChunk => {
    const meta = {
      source: o.source ?? 'upload', sourceId: o.sourceId ?? 'doc.md',
      userId: o.userId, sessionId: o.sessionId ?? 's1', createdAt: '2026-06-01T00:00:00Z',
    }
    return { id: o.id, vector: o.vector, chunk: { id: o.id, text: o.text, source: `${meta.source}:${meta.sourceId}`, score: 0 }, meta }
  }

  it('persists, hydrates after a "restart", ranks by cosine, and deletes tenancy-scoped', async () => {
    const pool = await createPgPool(url!)
    try {
      await pool.query('DROP TABLE IF EXISTS vector_chunks CASCADE')
      await runMigrations(pool)
      await runMigrations(pool) // idempotent: the vector_chunks DDL + index must not throw twice

      const first = new PgVectorStore(pool)
      first.upsert(mkChunk({ id: 'a', userId: 'u1', vector: [1, 0, 0], text: 'durable chunk' }))
      first.upsert(mkChunk({ id: 'b', userId: 'u1', vector: [0, 1, 0], text: 'other chunk' }))
      first.upsert(mkChunk({ id: 'c', userId: 'u2', vector: [1, 0, 0], text: 'tenant two' }))
      await first.flush()

      // Restart: a brand-new store hydrates the SAME corpus from the table.
      const second = new PgVectorStore(pool)
      await second.hydrate()
      expect(second.size()).toBe(3)
      // cosine ranking + tenancy: u1 querying [1,0,0] gets 'a' first, never u2's 'c'.
      const res = second.search([1, 0, 0], { userId: 'u1' }, 5)
      expect(res.map(s => s.stored.id)).toEqual(['a', 'b'])
      expect(res[0]!.stored.chunk.text).toBe('durable chunk')

      // Tenancy-scoped delete persists (and never touches u2).
      const removed = second.deleteBy(m => m.userId === 'u1' && m.sessionId === 's1' && m.source === 'upload' && m.sourceId === 'doc.md')
      expect(removed).toBe(2)
      await second.flush()
      const third = new PgVectorStore(pool)
      await third.hydrate()
      expect(third.size()).toBe(1)
      expect(third.has('c')).toBe(true)
    } finally {
      if (pool.end) await pool.end()
    }
  })

  /** BM25 (the lexical half of hybrid retrieval) survives a restart against REAL Postgres: persist
   *  a corpus, then rehydrate a BRAND-NEW Bm25Index from the SAME `vector_chunks` rows and prove an
   *  exact-term lexical query still hits. This is the must-have, proven end-to-end on real DDL. */
  it('rehydrates the BM25 lexical index from the persisted corpus after a "restart"', async () => {
    const pool = await createPgPool(url!)
    try {
      await pool.query('DROP TABLE IF EXISTS vector_chunks CASCADE')
      await runMigrations(pool)

      const first = new PgVectorStore(pool)
      first.upsert(mkChunk({ id: 'p1', userId: 'u1', vector: [1, 0, 0], text: 'the pgvector extension stores embeddings' }))
      first.upsert(mkChunk({ id: 'p2', userId: 'u1', vector: [0, 1, 0], text: 'reciprocal rank fusion blends lexical bm25' }))
      await first.flush()

      // Restart: a fresh vector store AND a fresh BM25 index hydrate from the SAME durable rows.
      const second = new PgVectorStore(pool)
      await second.hydrate()
      const bm25 = new Bm25Index()
      bm25.hydrate(second.hydratedChunks())
      expect(bm25.size()).toBe(2)

      // An exact lexical term the rehydrated BM25 must still match (not silently empty).
      const lex = bm25.search('pgvector', { userId: 'u1' }, 5)
      expect(lex.length).toBeGreaterThan(0)
      expect(lex[0]!.stored.chunk.text).toContain('pgvector')
      // Tenancy still applies post-rehydrate: another user sees nothing.
      expect(bm25.search('pgvector', { userId: 'u2' }, 5)).toHaveLength(0)
    } finally {
      if (pool.end) await pool.end()
    }
  })
})

/**
 * REAL pgvector integration (Part B): when the `vector` extension is reachable, the guarded
 * upgrade turns the `vector_chunks.vector` column into a real `vector(N)`, an ANN index exists,
 * and a vector query runs. This DETECTS the extension and SKIPS cleanly when it is unavailable
 * (a plain `postgres:16` / managed DB without pgvector) — so CI stays green either way. The unit
 * tests already prove the fallback path with a fake client; this proves the real-DDL happy path.
 */
describe.skipIf(!url)('pgvector real column upgrade (guarded, skips without the extension)', () => {
  it('upgrades the vector column to vector(N), indexes it, and answers a vector query — or skips if pgvector is absent', async () => {
    const pool = await createPgPool(url!)
    try {
      await pool.query('DROP TABLE IF EXISTS vector_chunks CASCADE')
      await runMigrations(pool)

      const dim = 3 // small test dim; the boot path derives this from the active embedder
      const res = await ensurePgVectorColumn(pool, dim)
      if (!res.enabled) {
        // pgvector is not installed on this Postgres — the column stays double precision[] and the
        // whole feature degrades gracefully. Assert the fallback held and SKIP the pgvector-only part.
        const { rows } = await pool.query(
          "SELECT udt_name FROM information_schema.columns WHERE table_name='vector_chunks' AND column_name='vector'",
        )
        expect(rows[0]!.udt_name).toBe('_float8') // double precision[] — the portable fallback
        return
      }

      // Extension present: the column is now a real `vector`, idempotently re-runnable.
      await ensurePgVectorColumn(pool, dim) // second run: column already vector, index IF NOT EXISTS → no-op
      const { rows: colRows } = await pool.query(
        "SELECT udt_name FROM information_schema.columns WHERE table_name='vector_chunks' AND column_name='vector'",
      )
      expect(colRows[0]!.udt_name).toBe('vector')

      // DEAD-INDEX REMOVAL (audit quick-win, e1b6c81): the ivfflat ANN index is no longer created —
      // no query uses it (ranking is in-JS), so ensurePgVectorColumn now DROPs it best-effort.
      // Assert the removal held: the upgrade must NOT leave the write-tax index behind. (When
      // ranking moves into pgvector SQL, the index returns TOGETHER with the query that uses it.)
      const { rows: idxRows } = await pool.query(
        "SELECT indexname FROM pg_indexes WHERE tablename='vector_chunks' AND indexname='vector_chunks_vector_ann_idx'",
      )
      expect(idxRows.length).toBe(0)

      // A real vector round-trips through the store (write-through to the vector(N) column) and a
      // native pgvector distance query runs against it. The 'vector' mode serializes the embedding
      // as the pgvector literal + casts it (the default 'array' mode would error on a vector column).
      const store = new PgVectorStore(pool, 'vector')
      store.upsert({
        id: 'v1', vector: [1, 0, 0],
        chunk: { id: 'v1', text: 'native vector row', source: 'upload:d', score: 0 },
        meta: { source: 'upload', sourceId: 'd', userId: 'u1', sessionId: 's1', createdAt: 't' },
      })
      await store.flush()
      // pgvector cosine-distance operator (<=>) against the typed column — proves it is a real vector.
      const { rows: q } = await pool.query("SELECT id FROM vector_chunks ORDER BY vector <=> '[1,0,0]' LIMIT 1")
      expect(q[0]!.id).toBe('v1')

      // And the synchronous store path still hydrates + ranks identically (column type is transparent).
      const reloaded = new PgVectorStore(pool)
      await reloaded.hydrate()
      expect(reloaded.search([1, 0, 0], { userId: 'u1' }, 5)[0]!.stored.id).toBe('v1')
    } finally {
      if (pool.end) await pool.end()
    }
  })
})
