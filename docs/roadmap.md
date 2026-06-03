# AKIS MVP — Roadmap (auto-RAG & Agents/Workflows)

> Milestone plan for the two additive features in `docs/rag-and-agents-design.md` (agentic-core revision).
> **⚠️ Rebased 2026-06-01** onto the agentic core (PR #1 `feat/agentic-core-gates`, PR #2 `feat/real-providers`) — there is **no FSM transition table**; the invariant is the **4 structural gates**.
> **Timing:** post-defense. v1 demo untouched.
> **GitHub mirror:** parent roadmap issue #4 + sub-issues #5–#10.
> All milestones ship behind a feature flag and must not touch the demo path or the gate contract test.

> **✅ Reconciled with shipped code (2026-06-03).** M0–M5 are merged (issues #5–#10 closed; see `git log`). Checkboxes below now reflect what is actually in the tree, grounded in the file noted after each tick. A handful of items are honestly **left unchecked** (real semantic embeddings, pgvector ANN, the golden-eval quality gate, the core-pipeline tool-loop, sandbox isolation) with a one-line note on *why*. For the canonical current state see `README.md`; for what's next see [`docs/NEXT.md`](NEXT.md).

---

## Milestone map (at a glance)

| # | Milestone | Lane | Depends on | Exit criterion |
|---|---|---|---|---|
| M0 | Frozen contracts + migration | D + E | #1 & #2 merged | Interfaces merged; `knowledge_chunks` migration reserved; no behavior |
| M1 | Auto-RAG core (`retrieve_knowledge` tool, flagged) | D (BE `knowledge/`) | M0, **CF2** (else DI-service fallback) | ingest→retrieve round-trip + golden-eval green; tool callable by AKIS/Scribe/ASK behind flag |
| M2 | Remaining RAG sources + rerank | D | M1 | repo + upload sources live; dedup/tenancy hardened |
| M3 | Agents tab (read-only) + model picker | E (FE) | M0, **CF1, CF3** | roster (AKIS+4) visible; per-agent model assigned via `/api/providers` |
| M4 | Workflow config + validation + custom agents | E (BE `workflows/`) | M0, M3, **CF4** | `WorkflowConfig` versioned; validates vs roles matrix + gates + catalog |
| M5 | Workflow builder + live preview UI | E (FE) | M4, **CF1, CF5** (+CF2 for real steps) | compose/save/select; resumable live AkisEvent preview + gate cards |

Lanes: **D** = BE `knowledge/`; **E** = BE `workflows/` + FE `features/agents/`. BE/FE always separate PRs.

---

## ✅ Core Foundations (were upstream prerequisites — now LANDED — see `docs/architecture-review.md`)
A code review (2026-06-01) found seams the plan assumed were **not built yet**. As of 2026-06-03 **all six have shipped** (file grounding in the rightmost column):

| CF | What | Blocks | Status |
|---|---|---|---|
| CF1 | Orchestrator HTTP routes + **SSE endpoint** (`GET /sessions/:id/events`) | M5, usability | ✅ `backend/src/api/sessions.routes.ts` + `sse.ts` |
| CF2 | **Real** provider-backed sub-agents + emit `tool_call`/`tool_result`/`preview` | M1 (RAG tool), M5 | ✅ Scribe/Proto/Trace call the LLM (`backend/src/orchestrator/subagents/*`); a generic tool-loop (`agent/tools/toolLoop.ts`) is wired into the **advisory/ASK** path, **not** the core build pipeline yet (see M1 note) |
| CF3 | **Per-agent** provider/model wiring | M3 (picker binding) | ✅ `backend/src/workflow/resolve.ts` builds a per-session orchestrator with per-agent `{provider,model}` |
| CF4 | **Data-driven roles + permission matrix + agent registry** | M4 (custom agents/presets) | ✅ `backend/src/agent/dynamic/AgentRegistry.ts` + `workflow/validate.ts` (gate-tool ownership matrix) |
| CF5 | **Resumable** stream (per-session `seq` + buffer + `Last-Event-ID`) | M5 reliability | ✅ `backend/src/events/bus.ts` + `api/sse.ts` + FE `frontend/src/live/EventStreamClient.ts` |
| CF6 | Core hardening (confirmPush atomicity, verify-capability wrap, fail-closed providers) | "flawless operation" | ✅ providers fail closed outside `NODE_ENV=test` (`agent/providers/createProvider.ts`); persistence/auth audit closed (PR #36) |

**Historical fallback (no longer needed):** RAG could have shipped as a DI service and the model picker read-only until CF3 — both CFs landed, so neither fallback was taken. RAG is reachable as a DI `KnowledgePort` (core pipeline, via SharedContext) **and** as an LLM-callable `retrieve_knowledge` tool (advisory path only — see M1 note).

---

## M0 — Frozen contracts + migration (do first, zero impl) ✅ SHIPPED
- [x] `KnowledgePort` — `ingest(record)` / `retrieve(query, ctx)` (`backend/src/knowledge/KnowledgePort.ts`)
- [x] `IngestRecord` — `{source, sourceId, userId, sessionId, agent?, commitSha?, content, contentHash, createdAt}` (`knowledge/IngestionSink.ts` + `KnowledgePort.ts`)
- [x] `RetrievalResult` — chunk + provenance + score (`knowledge/store/VectorStore.ts` `Scored`/`ChunkMeta`)
- [x] `EmbeddingProvider` port (`knowledge/embedding/EmbeddingProvider.ts`). NOTE: the only adapter today is the offline `LocalEmbeddingProvider` (signed feature-hash, no key); a KeyStore-backed semantic adapter is the deferred drop-in.
- [x] `WorkflowConfig` / `AgentConfig` / `CustomAgentSpec` — typed in `@akis/shared`, validated in `backend/src/workflow/validate.ts`
- [x] Migration for the persistent corpus — landed as `vector_chunks` (`user_id` + `session_id` columns) in `backend/src/store/pg.ts` (named `vector_chunks`, not `knowledge_chunks`; brute-force JS cosine, no `vector(N)`/pgvector)
- [x] **D1 unblocked** (#1 agentic core + bus + skills, #2 providers/KeyStore/`/api/providers` all merged); **D3** resolved by choosing the offline feature-hash embedding (so `vector(N)` was replaced by `double precision[]`)
- **Exit:** ✅ interfaces merged; consumers compile against them.

## M1 — Auto-RAG core (flag off) ✅ MOSTLY SHIPPED (2 items honestly deferred)
- [x] `knowledge/store/` — corpus store + typed repo (`MemoryVectorStore` default; durable `PgVectorStore` when `DATABASE_URL` set, w/ `user_id`/`session_id`). NOTE: **no pgvector ANN** — ranking is brute-force JS cosine; the persisted `vector_chunks` table is a plain `double precision[]`, re-hydrated into the in-memory index on boot.
- [x] `EmbeddingProvider` port + default adapter — `LocalEmbeddingProvider` (offline signed feature-hash; no key). The KeyStore-backed semantic adapter (open-decision #1) is **deferred**.
- [x] `ingestQueue` — async, idempotent, content-hash dedup, retry + dead-letter (`knowledge/ingest/IngestQueue.ts`, F1-AC7)
- [x] event-driven ingest sources — `IngestionSink` subscribes per session; conversation + agent-output + repo + upload sources (`knowledge/IngestionSink.ts`, `ingest/*Source.ts`, F1-AC2)
- [x] hybrid **vector + BM25** retrieval fused with RRF, **tenancy-filtered by `user_id`/`session_id`** (`retrieve/hybrid.ts` + `store/Bm25Index.ts`, F1-AC5). NOTE: BM25 is **in-memory only** (rebuilt from the corpus on boot), not a persisted index.
- [x] `retrieve_knowledge` **tool** registered (read-only, no gate cap) over the DI `KnowledgePort` (`agent/tools/retrieveKnowledgeTool.ts`, F1-AC9). NOTE: today it is wired into the **advisory/ASK** agent (`agent/dynamic/AdvisoryAgent.ts`), **not** the core Scribe/Proto/Trace pipeline — the core pipeline gets RAG via the pre-assembled SharedContext, not an in-turn tool-loop. A core-pipeline tool-loop is the remaining piece (see `docs/NEXT.md`).
- [ ] **Golden eval set (≥20 query→chunk pairs) + top-5 ≥80% quality gate (F1-AC8)** — NOT built. No golden-eval suite exists in `backend/test`; retrieval quality is covered by unit/contract tests but not a measured top-5 quality gate. **Genuinely TODO.**
- [x] Observability: ingest success/fail, dead-letter depth, dedup-hit, retrieval metrics surfaced via `RagService.getMetrics` + `/api/knowledge` (F1-AC14; OpenTelemetry export is deferred — see `docs/NEXT.md`)
- [x] Wire RAG behind a feature flag; flag-off parity preserved (default-off wiring in `knowledge/buildRag.ts`; gate contract test untouched, F1-AC11)
- [x] **Contract test:** ingest → retrieve round-trip + provenance (RAG + boot-wiring tests in `backend/test`)
- **Exit:** ✅ round-trip green and gates untouched; ⚠️ the **quality gate** (golden-eval) is the one exit criterion still open.

## M2 — Remaining RAG sources + rerank ✅ SHIPPED
- [x] `repoSource` — GitHub repo files; real `RealGitHubRepoReader` behind `AKIS_GITHUB_TOKEN`, mock adapter otherwise (`knowledge/ingest/RepoSource.ts` + `RealGitHubRepoReader.ts`; auto-ingest on `confirmPush`)
- [x] `uploadSource` — parse PDF/markdown/text uploads (`knowledge/ingest/UploadSource.ts` + `parse/parseUpload.ts`)
- [x] reranker — pluggable + skippable second stage (`LocalReranker`/`NoopReranker`, `retrieve/Reranker.ts`); offline lexical-overlap re-score (no model/network). A cross-encoder API adapter is the deferred drop-in.
- [x] Structure-aware chunking (code by symbol, spec by section, prose by paragraph) (`knowledge/ingest/structureChunk.ts` + `chunk.ts`)
- [x] Secret/binary exclusion before embedding (`knowledge/ingest/exclude.ts`, F1-AC12) + dedup/tenancy hardening
- **Exit:** ✅ all sources auto-ingest with zero manual action; rerank toggleable. NOTE: the `p95 < 300 ms` budget is **not benchmarked/asserted** in CI (no perf gate) — treat it as a design target, not a verified number.

## M3 — Agents tab (read-only) + model picker ✅ SHIPPED
- [x] `frontend/src/agents/AgentsTab.tsx` — read-only roster (Scribe/Proto/Trace/Critic; roles are structural) with a per-agent picker
- [x] per-agent base prompt + selected skills + assigned model surfaced (read-only roster; selection persisted as a `WorkflowConfig`)
- [x] model picker consumes `GET /api/providers` and saves per-agent `{providerId, modelId}` (F2-AC6); key add/replace/remove via `PUT/DELETE /api/providers` (`backend/src/api/providers.routes.ts`)
- [x] feature-sliced FE (`frontend/src/agents`, `workflows`, `live`, `chat`), i18n via `useI18n` (`frontend/src/i18n`)
- **Exit:** ✅ roster visible; user manages keys + assigns per-agent models. (Full workflow editing arrives in M5.)

## M4 — Workflow config + validation + custom agents ✅ SHIPPED
- [x] `WorkflowConfig` + `AgentConfig` + `CustomAgentSpec` types (in `@akis/shared`; consumed by `backend/src/workflow/*`)
- [x] versioned persistence — `WorkflowStore` (in-memory) + `PgWorkflowStore` (a new row per version; in-flight runs pin their version, F2-AC10) (`backend/src/workflow/WorkflowStore.ts` + `PgWorkflowStore.ts`)
- [x] validation vs the gate-tool ownership matrix + 4 gate invariants + `catalog.ts` (`backend/src/workflow/validate.ts`, F2-AC4)
- [x] custom (non-core) agents registered with **no gate capability** (runtime re-check rejects any gate cap) (`backend/src/agent/dynamic/AgentRegistry.ts`, F2-AC3)
- [x] orchestrator consumes a resolved `WorkflowConfig` (per-agent models/tools/iterate budget/RAG) with no new control flow (`backend/src/workflow/resolve.ts`, F2-AC9)
- [x] tests — producer granted a gate tool / unknown model / over-budget iterate → save-time error; gates stay structural (`backend/test` workflow validate suite)
- **Exit:** ✅ workflows persisted/versioned; invalid configs rejected at save; gate contract test unchanged. NOTE: custom-agent **registration/validation** is shipped backend-side; a dedicated **custom-agent authoring UI** is not (the builder edits the core roster) — see `docs/NEXT.md`.

## M5 — Workflow builder + live preview UI ✅ SHIPPED
- [x] `frontend/src/workflows/WorkflowList.tsx` — saved workflows + versions
- [x] `frontend/src/workflows/WorkflowBuilder.tsx` — enable agents/tools (gate tools locked to owner role), pre-select curated skills, per-agent model, tighten-only gate policy, iterate budget (clamped 1..3), RAG toggle
- [x] `frontend/src/workflows/WorkflowPreview.tsx` — the seeded run stays gated (4 gates visible)
- [x] live preview — `frontend/src/live/*` (`EventStreamClient`, `useLiveSession`, `viewModel`) + `frontend/src/chat/RunPipeline.tsx` consume the resumable `AkisEvent` stream: per-agent step tree, gate cards, `verify`, `preview` URL, always-visible History (F2-AC7)
- **Exit:** ✅ user composes/saves/selects a workflow and watches a run live with gates surfaced (resumable across refresh/reconnect, F2-AC12).

---

## Open decisions — RESOLVED (how each landed)
(from `docs/rag-and-agents-design.md §E`)
1. Embedding provider default → **resolved: offline signed feature-hash** (`LocalEmbeddingProvider`, no key, replaced `vector(N)` with `double precision[]`). A KeyStore-backed semantic adapter remains a deferred drop-in (`docs/NEXT.md`).
2. Rerank budget → **resolved: pluggable + skippable** (`LocalReranker`/`NoopReranker`); default-off stack wires the no-op. The `p95 < 300 ms` budget is **not benchmarked** (no perf gate).
3. Repo ingestion guardrails → **resolved:** secret/binary exclusion (`ingest/exclude.ts`) + real GitHub reader behind `AKIS_GITHUB_TOKEN`, auto-ingest on `confirmPush`.
4. Custom-agent capability surface → **resolved: never a gate capability** — enforced at save (`workflow/validate.ts`) and at runtime registration (`agent/dynamic/AgentRegistry.ts`).
5. Workflow gate policy → **resolved: tighten-only** (additive gate policy; iterate budget clamped to the hard cap).
6. Model-selection persistence → **resolved: per-workflow** (versioned `WorkflowConfig`), with a per-session bind at start (`sessions.routes.ts`).
