import type { EventBus } from '../events/bus.js'
import { type EmbeddingProvider } from './embedding/EmbeddingProvider.js'
import { selectEmbeddingProvider, type KeyLookup } from './embedding/ApiEmbeddingProvider.js'
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
import { RealGitHubRepoReader } from './ingest/RealGitHubRepoReader.js'
import { UploadSource } from './ingest/UploadSource.js'
import { MockGitHubAdapter } from '../di/MockGitHubAdapter.js'

export interface BuildRagOpts {
  bus: EventBus
  /** Embedding seam. An explicit provider wins; otherwise it is SELECTED from `env`/`keyStore`:
   *  a real ApiEmbeddingProvider (OpenAI text-embedding-3-small) when its key resolves, else the
   *  offline LocalEmbeddingProvider (deterministic, no key). Under NODE_ENV=test it ALWAYS stays
   *  on Local (offline + deterministic suite/golden eval). The active `dim` follows the selection. */
  embedding?: EmbeddingProvider
  /** The encrypted KeyStore consulted (after env) to resolve the embedding key — the SAME store
   *  the chat providers use. Only used when no explicit `embedding` is given. */
  keyStore?: KeyLookup
  /** The vector corpus store. Defaults to the in-memory MemoryVectorStore (the keyless
   *  default, lost on restart). When DATABASE_URL is set the server injects a hydrated
   *  PgVectorStore (durable across restart) behind the SAME VectorStore interface — no
   *  consumer changes. The default path stays byte-for-byte unchanged. */
  vectorStore?: VectorStore
  /** The BM25 lexical index (the OTHER half of hybrid retrieval). Defaults to a FRESH, empty
   *  Bm25Index — the in-memory default, byte-for-byte unchanged. When DATABASE_URL is set the
   *  server injects an index ALREADY HYDRATED from the persisted `vector_chunks` corpus, so the
   *  lexical half survives a restart alongside the PgVectorStore (it is otherwise silently
   *  rebuilt empty on boot, degrading RRF to vector-only). In-memory-store-agnostic: with no
   *  Pg backing the default empty index is used exactly as before. */
  bm25?: Bm25Index
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
   *  When omitted, the reader is selected from `env`: a RealGitHubRepoReader when
   *  AKIS_GITHUB_TOKEN is set, else the default MockRepoReader. */
  repoReader?: RepoReader
  /** Env source for repo-reader selection (AKIS_GITHUB_TOKEN + repo target). Defaults to
   *  none → MockRepoReader (ZERO behavior change when no token is configured). */
  env?: Record<string, string | undefined>
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
  /** The selected repo read seam (RealGitHubRepoReader when AKIS_GITHUB_TOKEN is set, else
   *  MockRepoReader). Surfaced so a host can prime/refresh the real reader's snapshot. */
  repoReader: RepoReader
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
  // Embedding selection: an explicit provider wins; else select from env/keyStore — the real
  // ApiEmbeddingProvider when an OpenAI key resolves, else the offline LocalEmbeddingProvider
  // (and ALWAYS Local under NODE_ENV=test). The vector stores are dim-agnostic, so the active
  // `embedding.dim` flows through unchanged — nothing downstream hardcodes a dimension.
  const embedding =
    opts.embedding ??
    selectEmbeddingProvider({
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.keyStore ? { keyStore: opts.keyStore } : {}),
    })
  const userIdFor = opts.userIdFor ?? (() => 'local')
  const queue = new IngestQueue(opts.queue ?? {})
  const rerankOn = opts.rerank ?? true
  const service = new RagService({
    embedding,
    vectorStore: opts.vectorStore ?? new MemoryVectorStore(),
    // An injected (already-hydrated) BM25 index wins; else a fresh empty one (in-memory default,
    // unchanged). The Pg boot path hydrates this from the persisted corpus so RRF's lexical half
    // survives a restart — see BuildRagOpts.bm25.
    bm25: opts.bm25 ?? new Bm25Index(),
    queue,
    // Default reranker is the offline LocalReranker; a default-off stack wires the
    // NoopReranker so retrieval returns the raw fused order even on default calls.
    reranker: rerankOn ? new LocalReranker() : new NoopReranker(),
    rerankDefault: rerankOn,
    ...(opts.now ? { now: opts.now } : {}),
  })
  const port = new RagKnowledgePort(service, userIdFor)
  const sink = new IngestionSink({ bus: opts.bus, rag: service, userIdFor })
  // Repo read seam (precedence): an explicit `repoReader` wins; else select from `env`
  // (RealGitHubRepoReader when AKIS_GITHUB_TOKEN is set); else the default MockRepoReader
  // over the shared adapter (so the orchestrator's pushes are immediately readable). The
  // default is OFFLINE with ZERO behavior change when no token is configured.
  const reader =
    opts.repoReader ??
    selectRepoReaderFromEnv(opts.env) ??
    new MockRepoReader(opts.github ?? new MockGitHubAdapter())
  const repoSource = new RepoSource({ rag: service, queue, reader })
  const uploadSource = new UploadSource({ rag: service, queue })
  return { service, port, sink, queue, repoSource, uploadSource, userIdFor, repoReader: reader }
}

/**
 * Select the REAL GitHub reader iff AKIS_GITHUB_TOKEN is set (the opt-in switch). Returns
 * undefined otherwise → the caller falls through to the default MockRepoReader (DEFAULT OFF:
 * no token ⇒ zero behavior change).
 *
 * Repo target (minimal, env-driven, same spirit as the rest of server env handling):
 *  - AKIS_GITHUB_TOKEN  — required to enable (Bearer auth; never logged/leaked).
 *  - AKIS_GITHUB_REPO   — "owner/name" of the user's OWN repo to ingest.
 *                         Also accepts owner+name split across AKIS_GITHUB_OWNER/REPO.
 *  - AKIS_GITHUB_REF    — optional branch/tag/sha (defaults to the repo default branch).
 *  - AKIS_GITHUB_API_BASE — optional, for GitHub Enterprise.
 *
 * If the token is set but no repo target can be resolved we fall back to the mock rather
 * than throw — a misconfigured opt-in must never break the default boot path.
 */
function selectRepoReaderFromEnv(env: Record<string, string | undefined> | undefined): RepoReader | undefined {
  const token = env?.AKIS_GITHUB_TOKEN
  if (!token) return undefined // DEFAULT OFF
  const target = resolveRepoTarget(env)
  if (!target) return undefined // misconfigured opt-in → fall through to the mock default
  return new RealGitHubRepoReader({
    owner: target.owner,
    repo: target.repo,
    token,
    ...(target.ref !== undefined ? { ref: target.ref } : {}),
    ...(env?.AKIS_GITHUB_API_BASE ? { apiBase: env.AKIS_GITHUB_API_BASE } : {}),
  })
}

/** Parse the owner/repo/ref target from env. Accepts AKIS_GITHUB_REPO="owner/name" or the
 *  AKIS_GITHUB_OWNER + AKIS_GITHUB_REPO pair. Returns undefined when underspecified. */
function resolveRepoTarget(
  env: Record<string, string | undefined> | undefined,
): { owner: string; repo: string; ref?: string } | undefined {
  const ref = env?.AKIS_GITHUB_REF?.trim() || undefined
  const owner = env?.AKIS_GITHUB_OWNER?.trim()
  const repoRaw = env?.AKIS_GITHUB_REPO?.trim()
  if (owner && repoRaw && !repoRaw.includes('/')) {
    return { owner, repo: repoRaw, ...(ref ? { ref } : {}) }
  }
  if (repoRaw && repoRaw.includes('/')) {
    const [o, r] = repoRaw.split('/', 2)
    if (o && r) return { owner: o, repo: r, ...(ref ? { ref } : {}) }
  }
  return undefined
}
