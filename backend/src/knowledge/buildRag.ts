import type { EventBus } from '../events/bus.js'
import { LocalEmbeddingProvider, type EmbeddingProvider } from './embedding/EmbeddingProvider.js'
import { MemoryVectorStore } from './store/MemoryVectorStore.js'
import type { VectorStore } from './store/VectorStore.js'
import { Bm25Index } from './store/Bm25Index.js'
import { IngestQueue, type IngestQueueOpts } from './ingest/IngestQueue.js'
import { RagService } from './RagService.js'
import { RagKnowledgePort } from './RagKnowledgePort.js'
import { IngestionSink } from './IngestionSink.js'
import { LocalReranker, NoopReranker } from './retrieve/Reranker.js'
import { RepoSource } from './ingest/RepoSource.js'
import { MockRepoReader, type RepoReader } from './ingest/RepoReader.js'
import { UploadSource } from './ingest/UploadSource.js'
import { MockGitHubAdapter } from '../di/MockGitHubAdapter.js'

export interface BuildRagOpts {
  bus: EventBus
  /** Defaults to the offline LocalEmbeddingProvider (deterministic, no key). */
  embedding?: EmbeddingProvider
  /** The vector corpus store. Defaults to the in-memory MemoryVectorStore (the keyless
   *  default, lost on restart). When DATABASE_URL is set the server injects a hydrated
   *  PgVectorStore (durable across restart) behind the SAME VectorStore interface — no
   *  consumer changes. The default path stays byte-for-byte unchanged. */
  vectorStore?: VectorStore
  /** Single-user MVP → a constant tenant; multi-tenant resolves a real user id later. */
  userIdFor?: (sessionId: string) => string
  queue?: IngestQueueOpts
  /** Default second-stage rerank toggle (issue #7 AC3). Defaults to true (on).
   *  false wires a NoopReranker so retrieval returns the raw fused order. A skippable
   *  quality knob, never a gate. Per-call `rerank` can still override. */
  rerank?: boolean
  /** The shared MockGitHubAdapter the orchestrator pushes to (issue #7 AC1). The default
   *  RepoReader (MockRepoReader) reads from it, so a freshly pushed repo is immediately
   *  ingestable. A `repoReader` override wins (real GitHub later, opt-in). */
  github?: MockGitHubAdapter
  /** Override the repo read seam directly (a real GitHub reader behind AKIS_GITHUB_TOKEN).
   *  When omitted, a MockRepoReader over `github` (or a fresh adapter) is used. */
  repoReader?: RepoReader
  now?: () => string
}

export interface RagStack {
  service: RagService
  port: RagKnowledgePort
  sink: IngestionSink
  queue: IngestQueue
  /** Repo ingestion source (issue #7 AC1) — incremental by head sha + per-file hash. */
  repoSource: RepoSource
  /** Upload ingestion source (issue #7 AC2) — parse + structure-chunk + ingest. */
  uploadSource: UploadSource
  /** The tenancy resolver the port retrieves with — the upload/repo routes MUST stamp
   *  ingestion with this exact resolver so a write is retrievable through the port. */
  userIdFor: (sessionId: string) => string
}

/**
 * Assemble the embedded RAG stack (local embedding + in-memory vector store + BM25
 * + queue + service + port + bus sink + repo/upload sources). A pgvector-backed store /
 * API embedding provider drop in behind the same seams later without touching consumers.
 *
 * The repo + upload sources call rag.ingest() directly (off the gate path) — they hold
 * NO gate capability; the upload route owns owner-scoping, never gate authority.
 */
export function buildRag(opts: BuildRagOpts): RagStack {
  const embedding = opts.embedding ?? new LocalEmbeddingProvider()
  const userIdFor = opts.userIdFor ?? (() => 'local')
  const queue = new IngestQueue(opts.queue ?? {})
  const rerankOn = opts.rerank ?? true
  const service = new RagService({
    embedding,
    vectorStore: opts.vectorStore ?? new MemoryVectorStore(),
    bm25: new Bm25Index(),
    queue,
    // Default reranker is the offline LocalReranker; a default-off stack wires the
    // NoopReranker so retrieval returns the raw fused order even on default calls.
    reranker: rerankOn ? new LocalReranker() : new NoopReranker(),
    rerankDefault: rerankOn,
    ...(opts.now ? { now: opts.now } : {}),
  })
  const port = new RagKnowledgePort(service, userIdFor)
  const sink = new IngestionSink({ bus: opts.bus, rag: service, userIdFor })
  // Repo read seam: an explicit reader wins; else a MockRepoReader over the shared
  // adapter (so the orchestrator's pushes are immediately readable). Offline by default.
  const reader = opts.repoReader ?? new MockRepoReader(opts.github ?? new MockGitHubAdapter())
  const repoSource = new RepoSource({ rag: service, queue, reader })
  const uploadSource = new UploadSource({ rag: service, queue })
  return { service, port, sink, queue, repoSource, uploadSource, userIdFor }
}
