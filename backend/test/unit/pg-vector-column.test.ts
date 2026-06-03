import { describe, it, expect } from 'vitest'
import { ensurePgVectorColumn, type SqlClient } from '../../src/store/pg.js'
import { activeEmbeddingDim } from '../../src/knowledge/embedding/ApiEmbeddingProvider.js'

/** A fake SqlClient: records every statement, and lets a test script per-statement behavior
 *  (throw to simulate a missing extension, or return scripted rows for the type probe). */
function fakeDb(opts: {
  onQuery?: (sql: string) => Array<Record<string, unknown>> | void // returns rows, or throws
} = {}) {
  const sqls: string[] = []
  const db: SqlClient = {
    async query(text) {
      sqls.push(text.trim())
      const rows = opts.onQuery?.(text.trim())
      return { rows: rows ?? [] }
    },
  }
  return { db, sqls }
}

describe('ensurePgVectorColumn (Part B: guarded real pgvector column)', () => {
  it('FALLS BACK (enabled:false) and issues NO ALTER when the `vector` extension is unavailable', async () => {
    // Simulate a Postgres without pgvector: CREATE EXTENSION throws (like the real 0A000/42501).
    const { db, sqls } = fakeDb({
      onQuery: sql => { if (sql.startsWith('CREATE EXTENSION')) throw new Error('extension "vector" is not available') },
    })
    const res = await ensurePgVectorColumn(db, 256)
    expect(res.enabled).toBe(false)
    // It must not have attempted to ALTER the column type (that would error on a double precision[] DB).
    expect(sqls.some(s => s.startsWith('ALTER TABLE vector_chunks ALTER COLUMN vector TYPE'))).toBe(false)
  })

  it('when the extension IS present and the column is NOT yet a vector, creates the extension, ALTERs to vector(N), and creates an ANN index', async () => {
    const { db, sqls } = fakeDb({
      onQuery: sql => {
        // The type probe reports a non-vector udt (the existing double precision[] column → '_float8').
        if (sql.startsWith('SELECT udt_name')) return [{ udt_name: '_float8' }]
      },
    })
    const res = await ensurePgVectorColumn(db, 1536)
    expect(res.enabled).toBe(true)
    expect(sqls).toContain('CREATE EXTENSION IF NOT EXISTS vector')
    // The dim flows into the ALTER (parameterized by the active embedding dim).
    expect(sqls.some(s => /ALTER TABLE vector_chunks ALTER COLUMN vector TYPE vector\(1536\)/.test(s))).toBe(true)
    expect(sqls.some(s => /CREATE INDEX IF NOT EXISTS \w+ ON vector_chunks USING ivfflat/.test(s))).toBe(true)
  })

  it('is idempotent: when the column is ALREADY a vector, it skips the ALTER (re-running boots cleanly)', async () => {
    const { db, sqls } = fakeDb({
      onQuery: sql => { if (sql.startsWith('SELECT udt_name')) return [{ udt_name: 'vector' }] },
    })
    const res = await ensurePgVectorColumn(db, 256)
    expect(res.enabled).toBe(true)
    expect(sqls.some(s => s.startsWith('ALTER TABLE vector_chunks ALTER COLUMN vector TYPE'))).toBe(false)
    // The index creation is still issued (IF NOT EXISTS → a no-op on a second run).
    expect(sqls.some(s => /CREATE INDEX IF NOT EXISTS \w+ ON vector_chunks USING ivfflat/.test(s))).toBe(true)
  })

  it('degrades to the fallback (enabled:false) if the ALTER itself fails (e.g. a non-castable legacy corpus)', async () => {
    const { db } = fakeDb({
      onQuery: sql => {
        if (sql.startsWith('SELECT udt_name')) return [{ udt_name: '_float8' }]
        if (sql.startsWith('ALTER TABLE vector_chunks ALTER COLUMN vector TYPE')) throw new Error('cannot cast')
      },
    })
    const res = await ensurePgVectorColumn(db, 256)
    expect(res.enabled).toBe(false) // boot must not break — keep the portable column
  })

  it('the column dim is the ACTIVE embedding dim: keyless default is 256 (LocalEmbeddingProvider)', () => {
    // No key resolvable → the offline local embedder is selected, whose dim is 256.
    expect(activeEmbeddingDim({ env: {} })).toBe(256)
    // NODE_ENV=test always pins local (offline/deterministic), so 256 there too.
    expect(activeEmbeddingDim({ env: { NODE_ENV: 'test' } })).toBe(256)
  })

  it('the column dim follows the catalog when a key + model resolve (OpenAI text-embedding-3-small = 1536)', () => {
    expect(activeEmbeddingDim({ env: { OPENAI_API_KEY: 'sk-x' } })).toBe(1536)
    // A non-test env with a key + an explicit catalog model uses that model's dim.
    expect(activeEmbeddingDim({ env: { OPENAI_API_KEY: 'sk-x', AKIS_EMBEDDING_MODEL: 'text-embedding-3-large' } })).toBe(3072)
  })
})
