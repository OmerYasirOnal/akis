import type { KnowledgeChunk } from '@akis/shared'
import type { EmbeddingProvider } from './embedding/EmbeddingProvider.js'
import type { VectorStore, StoredChunk, TenantFilter, ChunkMeta } from './store/VectorStore.js'
import type { Bm25Index } from './store/Bm25Index.js'
import { rrfFuse } from './retrieve/hybrid.js'
import { LocalReranker, type Reranker } from './retrieve/Reranker.js'
import { chunkText } from './ingest/chunk.js'
import { shouldExclude } from './ingest/exclude.js'
import { contentHash } from './ingest/hash.js'
import type { IngestQueue, IngestMetrics } from './ingest/IngestQueue.js'

export interface IngestInput {
  text: string
  source: string
  sourceId: string
  userId: string
  sessionId: string
  agent?: string
}

export interface RagServiceDeps {
  embedding: EmbeddingProvider
  vectorStore: VectorStore
  bm25: Bm25Index
  queue: IngestQueue
  /** Optional second-stage reranker (issue #7 AC3). Defaults to LocalReranker
   *  (offline, deterministic). Per-call `rerank` can still skip it. */
  reranker?: Reranker
  /** Whether reranking is on by default for retrieve() when the call gives no flag.
   *  Defaults to true (quality knob, not a gate). */
  rerankDefault?: boolean
  now?: () => string
}

/**
 * The knowledge engine: zero-touch ingest (exclude → chunk → hash/dedup → embed →
 * upsert + BM25) off the agent path via the queue, and hybrid (vector + BM25, RRF)
 * retrieval with tenancy isolation. Holds NO gate capability (F1-AC9/AC10) — it
 * never imports a minter and is only ever read by agents through SharedContext.
 */
export class RagService {
  private now: () => string
  private reranker: Reranker
  private rerankDefault: boolean
  constructor(private deps: RagServiceDeps) {
    this.now = deps.now ?? (() => new Date().toISOString())
    this.reranker = deps.reranker ?? new LocalReranker()
    this.rerankDefault = deps.rerankDefault ?? true
  }

  /** Enqueue ingestion (async, off the agent path). Returns immediately (F1-AC7). */
  ingest(input: IngestInput): void {
    const ex = shouldExclude(input.text, input.source)
    if (ex.excluded) {
      this.deps.queue.metrics.excluded++
      return
    }
    for (const text of chunkText(input.text)) {
      this.deps.queue.enqueue({ source: input.source, sourceId: input.sourceId }, async () => {
        const id = contentHash(text, { userId: input.userId, source: input.source, sourceId: input.sourceId })
        if (this.deps.vectorStore.has(id)) { this.deps.queue.metrics.dedupHits++; return } // F1-AC3
        const [vector] = await this.deps.embedding.embed([text])
        const meta: ChunkMeta = {
          source: input.source, sourceId: input.sourceId, userId: input.userId,
          sessionId: input.sessionId, createdAt: this.now(),
          ...(input.agent !== undefined ? { agent: input.agent } : {}),
        }
        const chunk: KnowledgeChunk = { id, text, source: `${input.source}:${input.sourceId}`, score: 0 }
        const stored: StoredChunk = { id, vector: vector!, chunk, meta }
        this.deps.vectorStore.upsert(stored)
        this.deps.bm25.add(stored)
      })
    }
  }

  /** Hybrid retrieval (vector + BM25 fused by RRF), tenancy-filtered (F1-AC5),
   *  then an optional second-stage rerank (issue #7 AC3). Exposes non-secret
   *  provenance on each chunk (F1-AC4) — never userId.
   *
   *  `rerank` (default = deps `rerankDefault`, i.e. on) is a skippable quality knob,
   *  NOT a gate: false runs the raw fused order, true re-scores the fused candidates
   *  against the query and re-orders before slicing to k. */
  async retrieve(query: string, filter: TenantFilter, k = 6, rerank?: boolean): Promise<KnowledgeChunk[]> {
    if (!query.trim() || this.deps.vectorStore.size() === 0) return []
    const [qv] = await this.deps.embedding.embed([query])
    const vec = this.deps.vectorStore.search(qv!, filter, k * 2)
    const lex = this.deps.bm25.search(query, filter, k * 2)
    // Fuse a WIDER candidate pool than k so the reranker has room to reorder, then
    // narrow to k (either via the reranker or a plain slice when skipped).
    const fused = rrfFuse([vec, lex], k * 2)
    const useRerank = rerank ?? this.rerankDefault
    const top = useRerank ? this.reranker.rerank(query, fused, k) : fused.slice(0, k)
    return top.map(s => {
      const m = s.stored.meta
      return {
        ...s.stored.chunk,
        score: s.score,
        provenance: { sourceId: m.sourceId, sessionId: m.sessionId, createdAt: m.createdAt, ...(m.agent !== undefined ? { agent: m.agent } : {}) },
      }
    })
  }

  /** Observability (F1-AC14): ingest/dead-letter/dedup counters + corpus size. */
  getMetrics(): IngestMetrics & { corpusSize: number } {
    return { ...this.deps.queue.metrics, corpusSize: this.deps.vectorStore.size() }
  }

  /** Right-to-forget (F1-AC13): idempotent delete by session or source. */
  deleteBySession(sessionId: string): number {
    this.deps.bm25.deleteBy(m => m.sessionId === sessionId)
    return this.deps.vectorStore.deleteBy(m => m.sessionId === sessionId)
  }
  deleteBySource(source: string, sourceId: string): number {
    this.deps.bm25.deleteBy(m => m.source === source && m.sourceId === sourceId)
    return this.deps.vectorStore.deleteBy(m => m.source === source && m.sourceId === sourceId)
  }
}
