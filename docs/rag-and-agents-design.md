# AKIS MVP — Auto-RAG & Agents/Workflows Design

> **Status:** design-direction, NOT yet implemented. Companion to `HANDOFF.md`.
> **Scope:** two additive features for the MVP clean hat — (1) a zero-touch **auto-RAG** knowledge layer, (2) an **Agents & Workflows** tab. Both are designed to sit *inside* the locked architecture (deterministic verified spine, modular monolith), not to bend it.
> **Branch:** `claude/akis-agents-rag-system-NDTAH`.

---

## 🇹🇷 Özet (bu ne?)

İki yeni özelliği MVP'nin temiz mimarisine **uyumlu** şekilde tasarlıyoruz:

1. **Otomatik RAG (sıfır-dokunuş bilgi katmanı).** Kullanıcı elle hiçbir şey eklemez. Konuşma geçmişi, GitHub repo içeriği, pipeline çıktıları (Scribe spec / üretilen kod / Critic & Trace sonuçları) ve doküman yüklemeleri **olay-tetikli (event-driven)** olarak otomatik ingest edilir. Embedding + vektör arama **sunucu tarafında (Postgres + pgvector)** çalışır — kullanıcının bilgisayarına ihtiyaç yok. Retrieval, Scribe ve ASK/CHAT'i besler; omurgayı değiştirmez.
2. **Agents & Workflows tabı.** Kullanıcı **var olan doğrulanmış stage'leri yapılandırır** (Scribe/Proto/Validator/Critic/Trace) — model slotları, prompt varyantları, iterate bütçesi, gate politikası, RAG ayarları. Bir "workflow" = kanonik verification chain üzerinde **adlandırılmış, versiyonlanmış bir konfigürasyon**dur; yeni keyfi agent/DAG **değildir**. Push-gate her workflow'da onaya kadar erişilemez kalır. Kilitli "full-agentic değil" kararına bilerek sadık kalır.

**Zamanlama:** Savunma sonrası (2026-06-12 sonrası). v1 demosu dokunulmaz; bu iş paralel/temiz hatta ilerler.

---

## 0. Design principles (inherited, non-negotiable)

These features obey the same bug-class-elimination rules as the rest of the MVP (`HANDOFF.md §6`):

- **Single source of truth for events.** Auto-RAG ingestion subscribes to the *same* backend-stamped event stream the FSM emits — it does NOT re-derive state or re-listen to a parallel channel. No FE-synthetic ingestion.
- **Typed contracts, no untyped bags.** Ingestion records, retrieval results, and workflow configs are all typed interfaces. A typo is a compile error, not a silent no-op three stages away.
- **Decoupled from the orchestrator.** v1's fatal pattern was injecting `ChatMemoryContextService` *inside* `PipelineOrchestrator` (`applyChatMemory`, orchestrator:404) — coupling the knowledge subsystem to the god-file. MVP inverts this: RAG is a standalone module exposing a thin `retrieve()` port; stages *pull* from it via DI, the orchestrator never wires it.
- **Spine stays deterministic.** RAG augments *prompts* (retrieval context); workflows *parameterize* stages. Neither adds a non-deterministic decision into the transition table.
- **Push gate structurally unreachable until approved** — regardless of RAG content or workflow config.
- **i18n lint gate** — every user-facing string in the Agents tab goes through the catalogue.

---

## PART A — Auto-RAG (zero-touch knowledge layer)

### A.1 Goal

A retrieval layer that is **always on, never configured by hand**, and **best-in-class for our corpus**. The user never clicks "add to knowledge base." Everything the platform already produces or touches becomes retrievable automatically, and that knowledge silently improves Scribe specs and ASK/CHAT answers.

### A.2 Where RAG runs — server-side pgvector (decided)

- Embedding generation + vector storage live in the **backend monolith** (Postgres 16 + pgvector, already in the stack — `HANDOFF.md §9.4`).
- **No client/desktop component.** The earlier "use the user's computer" idea is dropped in favor of the simpler, deterministic server path. (If API embedding cost ever becomes a concern, a local-embedding adapter can be added behind the same `EmbeddingProvider` port without touching callers — noted as future-work, not built now.)
- **Embedding provider is pluggable** behind an `EmbeddingProvider` interface. Default recommendation: a dedicated embedding model (e.g. Voyage AI — Anthropic's recommended embedding partner — or OpenAI `text-embedding-3-large`), since Claude is a generation model, not an embedding model. The provider choice is config, not code.

### A.3 Module shape (new ownership lane)

A self-contained backend slice, **not** wired through the orchestrator:

```
backend/src/knowledge/
  ingestion/
    sources/            # one connector per source, all implement IngestSource
      conversationSource.ts   # chat / ASK / CHAT messages
      pipelineSource.ts       # Scribe spec, generated code, Critic/Trace outputs
      repoSource.ts           # GitHub repo files (via existing GitHub MCP)
      uploadSource.ts         # user-uploaded PDF/markdown/text
    ingestQueue.ts      # idempotent, content-hash dedup, retry budget
    chunker.ts          # structure-aware chunking (code vs prose vs spec)
    embedder.ts         # EmbeddingProvider port + adapters
  retrieval/
    retrieve.ts         # hybrid search: vector + keyword(BM25), then rerank
    reranker.ts         # cross-encoder / LLM rerank (pluggable, optional)
  store/
    knowledgeSchema.ts  # pgvector tables (Drizzle)
    knowledgeRepo.ts    # typed CRUD over the store
  knowledgePort.ts      # public interface: ingest(record), retrieve(query, ctx)
  index.ts              # the ONLY surface other slices import
```

### A.4 Auto-ingestion — how "zero-touch" works

Ingestion is **event-driven**, hooked onto the same backend-stamped event bus the FSM already emits through. No polling, no manual step, no FE involvement:

| Source | Trigger (existing event) | What gets ingested |
|---|---|---|
| Conversation | message persisted (chat / ASK / CHAT) | message text + role + conversation/workflow id |
| Pipeline outputs | each `StageOutcome` committed in `transition()` | Scribe spec, generated code diff, Validator/Critic findings, Trace results |
| GitHub repo | repo connected / push event | repo file tree + file contents (incremental by commit) |
| Document uploads | upload endpoint persists a file | parsed text of PDF/markdown/text |

Key invariants (the design-out rules):

- **Idempotent + dedup.** Every record carries a `contentHash`; re-ingesting identical content is a no-op. Re-runs and replays never duplicate vectors.
- **Backend-stamped provenance.** Each chunk stores `{source, sourceId, workflowId, stage?, commitSha?, createdAt}` — all stamped server-side, never FE-synthesized. This is what lets retrieval cite *where* a fact came from.
- **Tenant/workflow scoping.** Retrieval is scoped to the user's own workspace + workflow by default; cross-workflow leakage is opt-in, not accidental. (Port v1's knowledge `security/verification` concerns here.)
- **Async, non-blocking.** Ingestion runs off the critical path via `ingestQueue`; a slow embed never stalls a stage transition.

### A.5 Retrieval — "best-in-class for our corpus"

Quality comes from a hybrid + reranked pipeline rather than naive top-k cosine:

1. **Hybrid recall** — vector similarity (pgvector) **unioned with** keyword/BM25 (Postgres FTS). Catches both semantic and exact-token matches (identifiers, error codes).
2. **Rerank** — a rerank pass (cross-encoder or LLM-judge) over the merged candidates; pluggable and skippable for latency-sensitive paths.
3. **Structure-aware chunking** — code chunked by symbol/function boundaries, specs by section, prose by semantic paragraph. Better chunks beat better models.
4. **Provenance-cited results** — every retrieved chunk returns its stamped source so Scribe/ASK can show "based on `spec.md` / `auth.ts:42` / earlier conversation."

### A.6 Where it plugs into the chain

- **Scribe** pulls relevant prior specs/repo context via `knowledgePort.retrieve()` (DI-injected, like every other stage dependency) to write better specs. Augments the *prompt*, not the FSM.
- **ASK/CHAT** (the free, non-pushing intent) uses retrieval to answer questions grounded in the project's own history and code.
- The transition table, gates, and verification chain are **untouched** — RAG is read-only context, never a control-flow input.

### A.7 Data model (sketch)

```
knowledge_chunks
  id            uuid pk
  workflow_id   uuid        # scope
  source        text        # conversation | pipeline | repo | upload
  source_id     text        # message id / stage id / file path / upload id
  stage         text null   # scribe | proto | critic | trace ... (pipeline only)
  commit_sha    text null   # repo provenance
  content       text
  content_hash  text        # idempotency / dedup
  embedding     vector(N)   # pgvector
  tsv           tsvector    # BM25 / keyword recall
  created_at    timestamptz # backend-stamped
```
Migration index reserved via the parallel-session reservation file (`HANDOFF.md §7`) before `db:generate`.

---

## PART B — Agents & Workflows tab

### B.1 Goal & the locked constraint

Give the user a UI to **see and configure the agents** and **assemble named workflows** — *within* the deterministic verified spine. The locked decision (`HANDOFF.md §3.2`, §3.7) is explicit: **NOT full-agentic.** A planner-agent that invents stages is the future-work slide, not this work. So:

> A **workflow** in AKIS = a *named, versioned configuration* over the canonical verification chain (`Scribe → gate → Proto → Validator → Critic → Trace → push-gate`). It is NOT an arbitrary DAG of user-defined agents.

This is the "Claude-Code-like workflow builder" reframed honestly for our thesis: the power the user wants (compose, name, reuse pipelines) without breaking the determinism that *is* the product.

### B.2 What a user can configure (the edges, never the spine)

Per agent (Scribe / Proto / Validator / Critic / Trace):
- **Model slot** — planner / default / validation slot, multi-provider (Claude primary).
- **Prompt variant** — choose/override the agent's prompt template (the valuable IP), versioned.
- **Enable/skip** where it is *legally* skippable (e.g. Trace skip already exists in v1) — and only where the transition table permits.

Per workflow:
- **Iterate budget** — the shared retry cap for the one verified iterate loop.
- **Gate policy** — which gates require explicit human approval (push-gate is always required; cannot be disabled).
- **RAG settings** — which sources feed retrieval for this workflow, rerank on/off.
- **Name + version** — workflows are saved, versioned, and selectable per run.

### B.3 The safety property — config validated against the transition table

A workflow config can only reference **legal** stages and transitions. It is validated against `fsm/transitionTable.ts` at save time:

- An illegal stage order or a disabled mandatory gate → **validation error at save**, never a runtime surprise.
- The push gate remains **structurally unreachable until approved** (`HANDOFF.md §6.8`) no matter what a workflow says.
- A workflow is therefore always a *subset/parameterization* of the canonical chain — provably still verified.

This is what keeps the feature on the right side of the locked decision: flexibility is at the edges (config), the spine (transition table) is the single immutable authority.

### B.4 Module shape

Backend (config + validation lane):
```
backend/src/workflows/
  workflowConfig.ts     # typed WorkflowConfig + AgentConfig interfaces
  workflowStore.ts      # versioned persistence (Drizzle)
  validateWorkflow.ts   # checks config against fsm/transitionTable.ts
  index.ts              # public surface
```
The orchestrator reads a resolved `WorkflowConfig` as input (which stages, which models, which prompts) — it does not learn new control flow. The transition table is unchanged; the config only selects/parameterizes within it.

Frontend (feature-sliced, same context discipline as chat):
```
frontend/src/features/agents/
  AgentsTab.tsx           # lists the 5 agents, shows config
  agentCard/              # per-agent editable config card
  workflows/
    WorkflowList.tsx      # saved workflows + versions
    WorkflowBuilder.tsx   # compose: toggle stages, set model/prompt/budget/gates
    WorkflowPreview.tsx   # renders the resulting canonical-chain subset (read-only)
  state/                  # contexts, not prop-drilling
  index.ts
```
The builder UI deliberately renders the **fixed chain** with configurable nodes — it visually communicates "you are tuning a verified pipeline," not "you are wiring arbitrary agents." That framing is a thesis asset, not a limitation.

### B.5 Relationship to RAG

The Agents tab exposes RAG as a per-workflow setting (which sources, rerank on/off) — but RAG still auto-ingests everything by default. The tab tunes retrieval; it never becomes the manual "add knowledge" button we explicitly avoided.

---

## PART C — Parallel-session ownership lanes (additive)

Extends `HANDOFF.md §7`. These two features are **disjoint new lanes**, designed to not collide with the in-flight spine/chat work:

- **Lane D — BE `knowledge/`** (auto-RAG): owns ingestion, retrieval, store. Only shared surface = `knowledgePort.retrieve()` consumed by Scribe/ASK (frozen interface).
- **Lane E — BE `workflows/` + FE `features/agents/`** (agents/workflows): owns config, validation, the tab. Only shared surface = reads `fsm/transitionTable.ts` (read-only) and supplies a `WorkflowConfig` to the orchestrator (frozen interface).

Frozen contracts to publish before dispatch: `KnowledgePort`, `IngestRecord`, `RetrievalResult`, `WorkflowConfig`, `AgentConfig`. BE/FE separate PRs.

---

## PART D — Phasing (post-defense)

1. **Phase 1 — Auto-RAG ingestion + retrieval (flagged off by default).**
   - `knowledge/` module, pgvector schema, `conversationSource` + `pipelineSource`, hybrid retrieve.
   - Wire `retrieve()` into Scribe + ASK behind a feature flag. Contract test: ingest → retrieve round-trip + provenance.
2. **Phase 2 — Remaining sources.** `repoSource` (GitHub MCP), `uploadSource` (PDF/markdown), rerank pass. Dedup/idempotency hardening.
3. **Phase 3 — Agents tab (read-only).** Display the 5 agents + their current config/prompts. No editing yet — de-risks the UI.
4. **Phase 4 — Workflow config + validation.** `WorkflowConfig`, `validateWorkflow` against the transition table, persistence/versioning.
5. **Phase 5 — Workflow builder UI.** Compose/save/select workflows; preview renders the verified-chain subset. RAG per-workflow settings.

Each phase ships behind a flag and lands without touching the demo path or the in-flight spine refactor.

---

## PART E — Open decisions (resolve before Phase 1 code)

1. **Embedding provider default** — Voyage AI vs OpenAI `text-embedding-3` vs self-hosted. (Recommendation: Voyage for quality, pluggable so it's reversible.) Affects `vector(N)` dimension in the schema.
2. **Rerank cost/latency budget** — is an LLM-judge rerank acceptable on the Scribe path, or keep rerank to ASK only?
3. **Repo ingestion size guardrails** — full repo vs changed-files-only; binary/asset exclusion rules; max repo size.
4. **Prompt-variant authoring** — do users write raw prompts in the Agents tab, or only pick from curated, version-pinned variants? (Recommendation: curated variants first; raw editing is a later, riskier step.)
5. **Workflow scope of "skip"** — confirm exactly which gates/stages are user-skippable vs always-mandatory (push-gate is always mandatory).

---

_Authored 2026-06-01 as an additive design on top of the 2026-05-31 handoff. Both features are deliberately constrained to the edges so the deterministic verified spine — the thesis — stays intact._
