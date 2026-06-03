import { type VectorStore, type StoredChunk, type TenantFilter, type Scored, type ChunkMeta } from './VectorStore.js'
import { MemoryVectorStore } from './MemoryVectorStore.js'
import type { SqlClient } from '../../store/pg.js'

/**
 * Postgres-backed vector store: the durable seam behind {@link VectorStore}, selected when
 * DATABASE_URL is set. The RAG corpus SURVIVES restart instead of being re-indexed from
 * scratch — every chunk is persisted to the `vector_chunks` table and re-loaded on boot.
 *
 * WHY a write-through in-memory index (not raw SQL per read): the {@link VectorStore}
 * interface is SYNCHRONOUS (`has`/`search`/`size`/`deleteBy` return values, not promises)
 * and is consumed synchronously by RagService (inside async ingest tasks, and in the sync
 * `getMetrics`/`deleteBy*` methods). Reproducing MemoryVectorStore's ranking byte-for-byte
 * AND keeping that interface unchanged means reads must hit an in-memory structure. So this
 * store DELEGATES every read (`has`/`search`/`size`) to an embedded {@link MemoryVectorStore}
 * — the EXACT reference ranking (cosine top-k, tenancy filter, identical ordering) — and
 * WRITES THROUGH to Postgres on every mutation. On boot, {@link hydrate} rebuilds that index
 * from the persisted rows, so the corpus is durable across restarts. JS-after-fetch cosine via
 * the reference store is the owner-sanctioned approach for the single-user corpus; ranking
 * parity is therefore EXACT by delegation, not by re-implementation.
 *
 * Holds NO gate capability — like MemoryVectorStore it is grounding only (F1-AC9/AC10).
 */
export class PgVectorStore implements VectorStore {
  /** The reference ranking engine: ALL reads delegate here, so ranking parity is exact. */
  private readonly index = new MemoryVectorStore()
  /** A parallel id→chunk map kept in lockstep with {@link index} (insertion order, same upsert
   *  semantics). Its ONLY job is to recover the ids deleted by a {@link deleteBy} predicate so
   *  the matching rows can be removed from Postgres (ChunkMeta carries no id). */
  private readonly byId = new Map<string, StoredChunk>()
  /** Serialized write-through chain; {@link flush} awaits it (shutdown + deterministic tests).
   *  Writes are fire-and-forget from the synchronous interface's perspective, but errors and
   *  completion are observable via flush(), and ops apply in submission order (a delete after an
   *  upsert can never race ahead of it). */
  private writes: Promise<void> = Promise.resolve()

  /**
   * `vectorColumn` selects how the embedding is serialized for the persisted column:
   *   - `'array'` (DEFAULT): a `double precision[]` column — pass the JS `number[]` straight
   *     through (node-postgres renders it as the `{…}` array literal). Today's behavior, byte-for-byte.
   *   - `'vector'`: a real pgvector `vector(N)` column — render the embedding as the pgvector text
   *     literal `[…]` and cast it (`$8::vector`), since node-postgres's `{…}` array form is NOT a
   *     valid `vector` input. The server passes this ONLY after {@link ensurePgVectorColumn}
   *     confirms the extension upgraded the column; absent that, the default keeps the array form.
   * Reads are unaffected — `parseVector` already handles both the `{…}` and `[…]` row literals.
   */
  constructor(private db: SqlClient, private vectorColumn: 'array' | 'vector' = 'array') {}

  /** Load the persisted corpus into the in-memory index. Call ONCE on boot (idempotent —
   *  re-hydrating just re-upserts the same ids). After this the store ranks exactly as a
   *  freshly-ingested MemoryVectorStore would. */
  async hydrate(): Promise<void> {
    const { rows } = await this.db.query(
      'SELECT id, vector, chunk, meta FROM vector_chunks ORDER BY seq ASC',
    )
    for (const row of rows) {
      const stored = rowToStored(row)
      if (stored) { this.index.upsert(stored); this.byId.set(stored.id, stored) }
    }
  }

  /**
   * The hydrated corpus, in seq (insertion) order — the SAME chunks {@link hydrate} loaded.
   * Lets a Pg boot rehydrate the lexical {@link Bm25Index} from the EXACT same rows (one scan,
   * no second query, no separate postings table to drift) so the durable corpus carries BOTH
   * halves of hybrid retrieval across a restart. Call right after {@link hydrate}, before any
   * live write, so the order mirrors `ORDER BY seq`. The byId map preserves insertion order, so
   * a chunk re-upserted live keeps its original position (Map semantics) — harmless for BM25,
   * which is order-insensitive at query time.
   */
  hydratedChunks(): StoredChunk[] {
    return [...this.byId.values()]
  }

  upsert(c: StoredChunk): void {
    this.index.upsert(c) // synchronous: reads see it immediately, identical to MemoryVectorStore
    this.byId.set(c.id, c)
    // On a real `vector(N)` column, cast the param ($8::vector) and pass the pgvector text literal
    // `[…]`; on the default `double precision[]` column, pass the JS number[] straight through (no
    // cast). Reads are identical either way.
    const vectorPlaceholder = this.vectorColumn === 'vector' ? '$8::vector' : '$8'
    const vectorParam: unknown = this.vectorColumn === 'vector' ? toPgVectorLiteral(c.vector) : c.vector
    this.enqueue(() =>
      this.db.query(
        `INSERT INTO vector_chunks (id, user_id, session_id, source, source_id, agent, created_at, vector, chunk, meta)
         VALUES ($1,$2,$3,$4,$5,$6,$7,${vectorPlaceholder},$9,$10)
         ON CONFLICT (id) DO UPDATE SET
           user_id = EXCLUDED.user_id, session_id = EXCLUDED.session_id,
           source = EXCLUDED.source, source_id = EXCLUDED.source_id, agent = EXCLUDED.agent,
           created_at = EXCLUDED.created_at, vector = EXCLUDED.vector,
           chunk = EXCLUDED.chunk, meta = EXCLUDED.meta`,
        [
          c.id, c.meta.userId, c.meta.sessionId, c.meta.source, c.meta.sourceId,
          c.meta.agent ?? null, c.meta.createdAt, vectorParam, toJson(c.chunk), toJson(c.meta),
        ],
      ).then(() => undefined),
    )
  }

  has(id: string): boolean {
    return this.index.has(id)
  }

  search(vector: number[], filter: TenantFilter, k: number): Scored[] {
    return this.index.search(vector, filter, k)
  }

  /**
   * Evaluate the (arbitrary ChunkMeta) predicate RagService passes — e.g. the tenancy-scoped
   * deleteBySourceFor — over the in-memory corpus, remove the matches from BOTH the reference
   * index and the id map, then write through a SINGLE `DELETE … WHERE id = ANY($1)` for exactly
   * those ids. Returns the count immediately (the interface is synchronous). Tenancy isolation is
   * preserved by the predicate's own userId/sessionId scope, so one tenant's removal never touches
   * another tenant's identically-pathed file. Idempotent: a predicate matching nothing issues no
   * DELETE. The reference {@link MemoryVectorStore.deleteBy} count is authoritative for the return.
   */
  deleteBy(pred: (m: ChunkMeta) => boolean): number {
    const ids: string[] = []
    for (const [id, c] of this.byId) {
      if (pred(c.meta)) ids.push(id)
    }
    // Apply to the reference index with the SAME predicate — its return is the source of truth
    // for the count and guarantees identical selection semantics to MemoryVectorStore.
    const n = this.index.deleteBy(pred)
    for (const id of ids) this.byId.delete(id)
    if (ids.length > 0) {
      this.enqueue(() => this.db.query('DELETE FROM vector_chunks WHERE id = ANY($1)', [ids]).then(() => undefined))
    }
    return n
  }

  size(): number {
    return this.index.size()
  }

  /** Await all pending write-through persists. Used by graceful shutdown and tests so a
   *  durable write is observable before assertions / process exit. */
  async flush(): Promise<void> {
    await this.writes
  }

  /** Chain a write so failures propagate through {@link flush} and writes apply in
   *  submission order. A SIDE catch observes the chain so a write that rejects AFTER the
   *  last flush() — e.g. a late upsert against a pool closed during shutdown — is logged,
   *  never an orphaned unhandled rejection. flush() still surfaces a live chain's failures. */
  private enqueue(op: () => Promise<void>): void {
    this.writes = this.writes.then(op, op)
    this.writes.catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error('vector_chunks write-through failed:', (err as Error)?.message ?? err)
    })
  }
}

/** Pass a chunk/meta payload to a jsonb column as a JS object (the driver serializes it; no
 *  pre-stringify), matching PgSessionStore.toJson. */
function toJson(v: unknown): unknown {
  return v == null ? null : v
}

/** Render an embedding as the pgvector text input literal — `[1,2,3]` — for a real `vector(N)`
 *  column (node-postgres's default `{1,2,3}` array form is NOT valid `vector` input). Non-finite
 *  components are coerced to 0 (pgvector rejects NaN/Inf) — defensive; the embedders never emit them. */
function toPgVectorLiteral(v: number[]): string {
  return `[${v.map(n => (Number.isFinite(n) ? n : 0)).join(',')}]`
}

/** The raw `vector_chunks` row as Postgres returns it. `vector` is `double precision[]`
 *  (→ number[]); `chunk`/`meta` are jsonb (→ parsed objects). A defensive parse also covers a
 *  driver/serializer that hands a JSON string back. Returns undefined for an unusable row. */
function rowToStored(raw: Record<string, unknown>): StoredChunk | undefined {
  const id = raw.id
  if (typeof id !== 'string') return undefined
  const vector = parseVector(raw.vector)
  const chunk = parseJson(raw.chunk) as StoredChunk['chunk'] | undefined
  const meta = parseJson(raw.meta) as ChunkMeta | undefined
  if (!vector || !chunk || !meta) return undefined
  return { id, vector, chunk, meta }
}

function parseVector(v: unknown): number[] | undefined {
  if (Array.isArray(v)) return v.map(Number)
  if (typeof v === 'string') {
    // A `double precision[]` literal can surface as e.g. "{1,2,3}", or a JSON "[1,2,3]".
    const trimmed = v.trim()
    const inner = trimmed.startsWith('{') && trimmed.endsWith('}')
      ? trimmed.slice(1, -1)
      : trimmed.replace(/^\[|\]$/g, '')
    if (inner.length === 0) return []
    return inner.split(',').map(s => Number(s))
  }
  return undefined
}

function parseJson(v: unknown): unknown {
  if (v == null) return undefined
  if (typeof v === 'string') {
    try { return JSON.parse(v) } catch { return undefined }
  }
  return v
}
