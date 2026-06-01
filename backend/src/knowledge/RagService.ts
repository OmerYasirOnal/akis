import type { KnowledgeChunk } from '@akis/shared'
import type { EmbeddingProvider } from './embedding/EmbeddingProvider.js'
import type { VectorStore, StoredChunk, TenantFilter, ChunkMeta } from './store/VectorStore.js'
import type { Bm25Index } from './store/Bm25Index.js'
import { rrfFuse } from './retrieve/hybrid.js'
import { chunkText } from './ingest/chunk.js'
import { shouldExclude } from './ingest/exclude.js'
import { contentHash } from './ingest/hash.js'
import type { IngestQueue } from './ingest/IngestQueue.js'

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
  constructor(private deps: RagServiceDeps) {
    this.now = deps.now ?? (() => new Date().toISOString())
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

  /** Hybrid retrieval (vector + BM25 fused by RRF), tenancy-filtered (F1-AC5). */
  async retrieve(query: string, filter: TenantFilter, k = 6): Promise<KnowledgeChunk[]> {
    if (!query.trim() || this.deps.vectorStore.size() === 0) return []
    const [qv] = await this.deps.embedding.embed([query])
    const vec = this.deps.vectorStore.search(qv!, filter, k * 2)
    const lex = this.deps.bm25.search(query, filter, k * 2)
    return rrfFuse([vec, lex], k).map(s => ({ ...s.stored.chunk, score: s.score }))
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
