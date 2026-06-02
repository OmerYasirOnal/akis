import type { EventBus } from '../events/bus.js'
import { LocalEmbeddingProvider, type EmbeddingProvider } from './embedding/EmbeddingProvider.js'
import { MemoryVectorStore } from './store/MemoryVectorStore.js'
import { Bm25Index } from './store/Bm25Index.js'
import { IngestQueue, type IngestQueueOpts } from './ingest/IngestQueue.js'
import { RagService } from './RagService.js'
import { RagKnowledgePort } from './RagKnowledgePort.js'
import { IngestionSink } from './IngestionSink.js'

export interface BuildRagOpts {
  bus: EventBus
  /** Defaults to the offline LocalEmbeddingProvider (deterministic, no key). */
  embedding?: EmbeddingProvider
  /** Single-user MVP → a constant tenant; multi-tenant resolves a real user id later. */
  userIdFor?: (sessionId: string) => string
  queue?: IngestQueueOpts
  now?: () => string
}

export interface RagStack {
  service: RagService
  port: RagKnowledgePort
  sink: IngestionSink
  queue: IngestQueue
}

/**
 * Assemble the embedded RAG stack (local embedding + in-memory vector store + BM25
 * + queue + service + port + bus sink). A pgvector-backed store / API embedding
 * provider drop in behind the same seams later without touching consumers.
 */
export function buildRag(opts: BuildRagOpts): RagStack {
  const embedding = opts.embedding ?? new LocalEmbeddingProvider()
  const userIdFor = opts.userIdFor ?? (() => 'local')
  const queue = new IngestQueue(opts.queue ?? {})
  const service = new RagService({
    embedding,
    vectorStore: new MemoryVectorStore(),
    bm25: new Bm25Index(),
    queue,
    ...(opts.now ? { now: opts.now } : {}),
  })
  const port = new RagKnowledgePort(service, userIdFor)
  const sink = new IngestionSink({ bus: opts.bus, rag: service, userIdFor })
  return { service, port, sink, queue }
}
