# Auto-RAG — zero-touch knowledge, embedded-first (sub-project 4)

**Goal:** A zero-touch knowledge layer: every conversation message / agent output
is ingested automatically off the agent path, and any agent can retrieve relevant
grounding through the existing `KnowledgePort` seam — with tenancy isolation,
idempotent ingestion, bounded-failure async ingest, and a measurable retrieval
quality bar. **Embedded/in-memory first** (local-first / self-hostable, like
Ollama); a `pgvector` adapter lands later behind the same seams.

**Maps to:** F1-AC1..AC14, AC17 (see mapping below). Feeds `SharedContext`
(sub-project 3) by replacing `NullKnowledgePort` with `RagKnowledgePort` when the
RAG flag is on.

**Invariants (must hold):** the 4 gates stay structural; gate contract (A–F)
GREEN; **no knowledge module imports a gate minter** (F1-AC10); `retrieve_knowledge`
is read-only and holds no gate capability (F1-AC9); with the RAG flag OFF, behavior
is identical to no-RAG (F1-AC11); API keys never in repo; tsc strict clean.

---

## Why embedded-first

The product vision is local-first / self-hostable (run on the user's own box, no
external services). An embedded vector store + a **deterministic local embedding**
default means RAG works offline, with zero infra, and is fully reproducible in
tests (the golden-eval gate needs determinism). The spec's `pgvector` is the
production scale path — kept behind the `VectorStore` + `EmbeddingProvider` seams
so it drops in without touching consumers (F1-AC6/AC15 deferred, seam ready).

---

## Components (all under `backend/src/knowledge/`)

### 1. EmbeddingProvider seam — `embedding/EmbeddingProvider.ts`
```ts
export interface EmbeddingProvider { readonly dim: number; embed(texts: string[]): Promise<number[][]> }
```
- **`LocalEmbeddingProvider`** (default; offline, deterministic): hashed
  bag-of-words → fixed-dim (256) L2-normalized vector. No network, no key — works
  out of the box and makes the golden eval reproducible.
- A real API-backed provider (reuse PR #2 catalog + KeyStore) is a later drop-in
  behind this interface (noted; not built now).

### 2. VectorStore seam + in-memory impl — `store/VectorStore.ts`, `store/MemoryVectorStore.ts`
```ts
export interface StoredChunk { id: string; vector: number[]; chunk: KnowledgeChunk; meta: ChunkMeta }
export interface VectorStore {
  upsert(c: StoredChunk): void                 // id = contentHash -> idempotent (F1-AC3)
  search(vector: number[], filter: TenantFilter, k: number): Scored[]   // cosine
  deleteBy(pred: (m: ChunkMeta) => boolean): number                     // F1-AC13
  size(): number
}
```
`ChunkMeta` = provenance: `{ source, sourceId, userId, sessionId, agent?, createdAt }`
(F1-AC4). `TenantFilter` = `{ userId; sessionId? }` — applied INSIDE search so a
chunk owned by user A is never returned to user B (F1-AC5).

### 3. BM25 lexical index — `store/Bm25Index.ts`
Classic BM25 over the same chunks (tokenized), tenancy-filtered. `add`, `search`.

### 4. Hybrid retrieve — `retrieve/hybrid.ts`
Reciprocal-Rank-Fusion (RRF) of the vector top-k and BM25 top-k → fused top-k.
(Rerank is an optional later stage; out of scope.)

### 5. Chunking + exclusion + hashing — `ingest/chunk.ts`, `ingest/exclude.ts`, `ingest/hash.ts`
- `chunkText(text): string[]` — split long text into overlapping windows.
- `shouldExclude(text, source): {excluded, reason?}` — secret denylist (API-key
  patterns, `.env`, `keys.json`) + binary detection (non-printable ratio) (F1-AC12).
- `contentHash(text, meta)` — sha256 → the chunk `id` for dedup (F1-AC3).

### 6. IngestQueue — `ingest/IngestQueue.ts`
Async, off the agent path (F1-AC7). `enqueue(task)`; a worker embeds+stores with
**≤3 retries, backoff 1s/4s/16s** (backoff injectable → 0 in tests). On budget
exhaustion → **dead-letter** list (observable, never silently dropped). Exposes
counters: `{ ingested, failed, deadLettered, dedupHits, queueDepth }` (F1-AC14).

### 7. RagService — `RagService.ts`
Ties it together: `ingest(input)` (exclude → chunk → hash/dedup → embed → upsert
+ bm25.add), `retrieve(query, filter, k)` (embed query → vector search + bm25 →
hybrid fuse → KnowledgeChunk[] with provenance). `deleteBySession`/`deleteBySource`
(F1-AC13). Holds NO gate capability.

### 8. RagKnowledgePort — `RagKnowledgePort.ts`
`implements KnowledgePort` → `retrieve(q)` = `RagService.retrieve(q.query,
{ userId, sessionId: q.sessionId }, q.limit ?? 6)`. Read-only (F1-AC9). This is
the real `KnowledgePort` that feeds `SharedContext`.

### 9. IngestionSink — `IngestionSink.ts` (F1-AC1/AC2/AC17)
`subscribeSession(sessionId, userId)` subscribes to the bus for that session and,
on each ingestible event, enqueues ingestion:
- `text` events (conversation/narration),
- agent outputs surfaced as events (`tool_result` results carrying spec/files
  summaries), and the persisted `SessionState.spec`/`.code` via a `text` snapshot.
Triggered by **subscribing as the session starts** (F1-AC17) — wired in
`Orchestrator.start`. No polling, single source = the bus (F1-AC2).

### 10. Wiring + feature flag — `di/services.ts`
`BuildServicesOptions.rag?: boolean` (or env `AKIS_RAG`). When ON: build a
`RagService` + `RagKnowledgePort` (→ `services.knowledge`) + register the
`IngestionSink` so `Orchestrator.start` subscribes it. When OFF (default):
`NullKnowledgePort` and no sink — behavior identical to today (F1-AC11).

---

## Mapping to acceptance criteria
| AC | How |
|---|---|
| AC1 zero-touch | IngestionSink enqueues from bus events automatically |
| AC2 event-driven, single source | subscribes the AkisEvent bus; no polling |
| AC3 idempotent | chunk id = contentHash → upsert dedups (dedupHits metric) |
| AC4 provenance | ChunkMeta on every chunk; exposed on retrieval |
| AC5 tenancy | TenantFilter inside vector + bm25 search; **negative test** |
| AC7 non-blocking + bounded failure | IngestQueue async, ≤3 retries+backoff, dead-letter |
| AC8 quality | golden eval set (≥20 pairs) → top-5 ≥80% asserted in test |
| AC9 retrieval = read-only port | RagKnowledgePort.retrieve; no gate cap |
| AC10 gates untouched | no knowledge file imports a gate minter (asserted) |
| AC11 flagged both ways | rag flag off → NullKnowledgePort; gate contract green both ways |
| AC12 secret/binary exclusion | shouldExclude before embedding; logged/counted |
| AC13 deletion | deleteBySession/Source tombstone; idempotent |
| AC14 observability | IngestQueue + store counters queryable |
| AC17 ingestion subscription | sink subscribes per session at Orchestrator.start |

**Deferred (seam ready, noted):** AC6 (Postgres+pgvector — embedded now), AC15
(re-index on embedding-dim change), AC16 (citation integrity / staleness),
real API embedding provider, rerank, the LLM-callable `retrieve_knowledge` tool
in a tool registry (no tool registry exists yet — RAG ships as a DI service per
the architecture review's documented fallback).

**Ingestion scope (honest):** the IngestionSink currently ingests **conversation /
`text` events** (zero-touch, bus-driven). Full agent-artifact ingestion (the spec
body / produced code as their own ingestible content) is a follow-up — those flow
through the bus as narration today; emitting/ingesting the full artifacts is a
small, additive next step behind the same sink. AC4 (provenance) and AC14
(metrics) ARE exposed: retrieved chunks carry `provenance` (never `userId`) and
`RagService.getMetrics()` returns the ingest/dedup/dead-letter counters + corpus size.

---

## Testing (TDD — failing test first)
1. **embedding**: LocalEmbeddingProvider deterministic, fixed dim, L2-normalized;
   same text → same vector; different text → different.
2. **vector store**: cosine ranking; upsert idempotent by id; tenancy filter;
   deleteBy.
3. **bm25**: lexical ranking; tenancy filter.
4. **hybrid (RRF)**: fuses both; a doc strong in either modality surfaces.
5. **chunk/exclude/hash**: chunking windows; secret + binary exclusion; stable hash.
6. **IngestQueue**: success path; retry then succeed; ≤3 fail → dead-letter (never
   dropped); counters; backoff injectable (0 in tests, no real waits).
7. **RagService**: ingest→retrieve round trip; dedup (re-ingest = no dup).
8. **tenancy negative (AC5)**: user A ingests; user B retrieves → never sees A's chunk.
9. **golden eval (AC8)**: seeded corpus + ≥20 query→expected pairs; top-5 ≥80%.
10. **port + flag (AC9/AC11)**: RagKnowledgePort read-only; flag OFF → NullKnowledgePort
    behavior and gate contract A–F green; flag ON → SharedContext gets chunks.
11. **sink (AC1/AC17)**: starting a session subscribes the sink; an emitted text
    event results in an ingested chunk (async drained); off the agent path.
12. **gates untouched (AC10)**: a test/grep asserts no knowledge file imports a
    gate minter; gate contract green with RAG on.
13. **Invariant guard**: tsc strict clean; full suite green.

## Out of scope (later)
- Postgres + pgvector adapter (AC6) and the re-index path (AC15).
- Real API embedding provider + rerank model.
- Citation-integrity/staleness (AC16); repo/upload ingestion sources (only the
  bus/conversation + agent outputs are ingested now — exclusion logic is built so
  repo/upload can be added safely).
- The LLM-callable `retrieve_knowledge` tool in a tool registry (DI service now).
