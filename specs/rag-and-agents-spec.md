# Spec — Auto-RAG & Agents/Workflows

> **Type:** requirements spec (what + acceptance criteria), not a design. Design lives in `docs/rag-and-agents-design.md`; phases in `docs/roadmap.md`.
> **Captures:** the user's two requests from 2026-06-01, reconciled with the locked architecture in `HANDOFF.md`.
> **Status:** revised after independent zero-context review — see `specs/review/2026-06-01-zero-context-review.md` for the review and per-finding responses.
> **Vocabulary:** milestones are `M0`–`M5` everywhere (the design doc's "Phase N" maps 1:1 to `M N`).

---

## 0. Source requests (verbatim intent)

1. *"Bir RAG sistemi kuralım ama otomatik kaydolsun, kullanıcı elle bir şey yapmasın, en iyilerinden olsun, gerekirse kullanıcının bilgisayarını kullanalım."*
   → A retrieval system that **auto-ingests** (zero manual user action), is **high-quality**, server-side.
2. *"Bir agents tabı olsun, workflow'lar oluşturabilen — Claude Code / Opus 4.8 ultracode'un yaptığı gibi."*
   → An **Agents tab** where the user can **compose workflows**.

Reconciliation decisions (confirmed with user):
- Timing = post-defense (v1 demo untouched).
- RAG runs **server-side** (pgvector); the "use the user's computer" idea is dropped.
- A "workflow" = a **config over the canonical verified chain**, NOT an arbitrary agent DAG (locked: not full-agentic).
- Auto-ingest corpus = conversation + pipeline outputs + GitHub repo + document uploads.
- **Tenancy key = `user_id` + `workflow_id`** (decided in review response R5). `knowledge_chunks` carries both; retrieval is filtered by `user_id` in the query layer.
- **Ingestion privacy posture (this phase) = exclude-then-embed.** Secrets and binaries are excluded before embedding; no further redaction of PII in conversation/uploads for the single-user post-defense MVP (justification in review response R3).

---

## Dependencies (must exist before this work is dispatched)
- **D1:** `fsm/transitionTable.ts` (the explicit FSM) and the **backend-stamped event bus** are delivered by the spine refactor (Lane A). M1 (`F1-AC2`) and M4 (`F2-AC3`, `F2-AC9`) are **blocked on D1** — do not dispatch them before the transition table + event bus exist.
- **D2:** Auth / user identity is available to stamp `user_id` on ingest (`F1-AC5`).
- **D3:** Embedding provider chosen (open question #1) before the `knowledge_chunks` migration is frozen in M0 — the `vector(N)` dimension depends on it.

---

## FEATURE 1 — Auto-RAG (zero-touch knowledge layer)

### F1 User stories
- **F1-US1** As a user, I never manually add knowledge; everything the platform touches becomes retrievable automatically.
- **F1-US2** As the Scribe stage, I retrieve relevant prior context so my specs are grounded in the project's own history and code.
- **F1-US3** As a user in ASK/CHAT, I get answers grounded in my project, with citations to where each fact came from.

### F1 Acceptance criteria
- **F1-AC1 (zero-touch ingest):** GIVEN a new conversation message, pipeline `StageOutcome`, connected repo, or uploaded document, WHEN it is persisted, THEN its content is ingested into the knowledge store **without any manual user action**.
- **F1-AC2 (event-driven, single source):** Ingestion is triggered by the **same backend-stamped event stream** the FSM emits (depends on **D1**). No polling; no FE-synthesized ingestion events.
- **F1-AC3 (idempotent):** GIVEN identical content is ingested twice (replay/re-run), THEN no duplicate vectors are created (content-hash dedup).
- **F1-AC4 (provenance):** Every stored chunk carries server-stamped `{source, sourceId, userId, workflowId, stage?, commitSha?, createdAt}`; retrieval results expose this provenance.
- **F1-AC5 (tenancy isolation):** Retrieval is filtered by `user_id` (+ `workflow_id` scope) **in the query layer**. GIVEN a chunk owned by user A, WHEN user B issues any retrieval, THEN A's chunk is never returned. Enforced by SQL predicate and covered by an automated **negative** test. Cross-workflow access for the same user is explicit, never implicit.
- **F1-AC6 (server-side):** Embedding generation + vector storage run server-side (Postgres + pgvector). No client/desktop component is required for the feature to work.
- **F1-AC7 (non-blocking + bounded failure):** Ingestion is async, off the FSM critical path. Each record gets **≤3 retries with exponential backoff (1s/4s/16s)**. GIVEN a record exhausts its retry budget, THEN it is moved to a **dead-letter state**, is observable (metric + log), and is **never silently dropped**; the originating stage transition still completes successfully regardless of embed outcome.
- **F1-AC8 (retrieval quality — measurable):** A versioned **golden eval set** of ≥20 `query → expected-chunk` pairs over a seeded corpus lives in the repo. Retrieval (hybrid vector + keyword/BM25, optional rerank) MUST place the expected chunk in the **top-5 for ≥80%** of eval queries. This bar is asserted by an automated test; dropping below it fails CI. ("Best-in-class" = meets/raises this bar, not a mechanism claim.)
- **F1-AC9 (decoupling):** The orchestrator does not wire the knowledge subsystem; stages obtain retrieval via a DI-injected `KnowledgePort.retrieve()`. (Designs out v1's `applyChatMemory` coupling.)
- **F1-AC10 (spine untouched):** RAG augments prompts only; it adds no input to the FSM transition table and changes no gate behavior.
- **F1-AC11 (flagged + tested both ways):** RAG is behind a feature flag. WITH the flag off, pipeline behavior is byte-identical to no-RAG, asserted by the contract/real-AI smoke test run with the flag toggled both ways.
- **F1-AC12 (secret/binary exclusion):** GIVEN repo or upload content matching the secret-pattern denylist (e.g. `.env`, key material) or a binary file type, WHEN ingestion runs, THEN that content is **excluded before embedding** and the exclusion is logged. This guardrail is a **prerequisite** for the repoSource/uploadSource ACs, not a deferred option.
- **F1-AC13 (deletion / right-to-forget):** GIVEN a conversation, workflow, or upload is deleted, THEN its derived chunks/vectors are deleted (or tombstoned) and are no longer retrievable; idempotent re-deletion is a no-op.
- **F1-AC14 (observability):** The knowledge subsystem exposes ingest success/failure counts, dead-letter/queue depth, dedup-hit rate, and retrieval latency, queryable without code changes.
- **F1-AC15 (re-index on model change):** GIVEN the embedding provider or vector dimension changes, THEN a defined re-index path exists; chunks of dimension `N` are never mixed with dimension `M` at query time (mixed dimensions are rejected).
- **F1-AC16 (provenance integrity for citations):** GIVEN a retrieval result cited in an ASK/CHAT answer whose source was later deleted/superseded, THEN the citation resolves to a still-valid state or is marked stale (no dangling citations).

### F1 Non-functional
- Embedding provider is pluggable (`EmbeddingProvider` port); default decided in open question #1. Vector dimension follows the chosen model. **Privacy note:** the default provider (e.g. Voyage/OpenAI) receives all ingested conversation/repo/upload content as a third-party processor — this is acceptable for the single-user MVP but must be stated to the user; revisit if multi-tenant.
- **Performance bound:** retrieval **p95 < 300 ms** on a corpus of ≤50k chunks (single-user load); rerank may be skipped on latency-sensitive paths to hold this.

### F1 Out of scope (this spec)
- Local/on-device embedding or indexing (future-work behind the same port).
- Knowledge editing/curation UI (auto-only by design).
- PII redaction beyond secret/binary exclusion (deferred; see R3).

---

## FEATURE 2 — Agents & Workflows tab

### F2 User stories
- **F2-US1** As a user, I can see the agents (Scribe/Proto/Validator/Critic/Trace) and their current configuration.
- **F2-US2** As a user, I can assemble, name, save, and version a **workflow** that tunes the verified chain.
- **F2-US3** As a user, when I build a workflow I can see it is still a verified pipeline (preview renders the canonical-chain subset).

### F2 Acceptance criteria
- **F2-AC1 (config, not DAG):** A workflow is a named, versioned configuration over the canonical chain (`Scribe → gate → Proto → Validator → Critic → Trace → push-gate`). The UI cannot define new agents or arbitrary stage graphs.
- **F2-AC2 (configurable fields):** Per agent: model slot, prompt variant, enable/skip **only where legal** (the exact skippable surface is governed by open question #5 — until resolved, no stage/gate is assumed skippable beyond v1's existing Trace-skip). Per workflow: iterate budget, gate policy, RAG settings, name + version.
- **F2-AC3 (validated against FSM):** GIVEN a workflow config, WHEN saved, THEN it is validated against `fsm/transitionTable.ts` (depends on **D1**); an illegal stage order or a disabled mandatory gate is **rejected at save time** with a clear error — never a runtime surprise.
- **F2-AC4 (push-gate inviolable):** No workflow config can disable or bypass the push-confirm gate; push stays structurally unreachable until human approval, regardless of config.
- **F2-AC5 (read-only first):** The Agents tab ships first as read-only (M3); editing/building arrives in later milestones (M4/M5).
- **F2-AC6 (preview):** The builder renders the resulting pipeline as a subset/parameterization of the canonical chain, communicating "you are tuning a verified pipeline."
- **F2-AC7 (i18n):** All user-facing strings go through the i18n catalogue (TR+EN); CI lint gate fails on hardcoded strings.
- **F2-AC8 (no prop-drilling):** The FE feature uses the feature-sliced context discipline, not a prop bag.
- **F2-AC9 (orchestrator input):** The orchestrator consumes a resolved `WorkflowConfig` as input (depends on **D1**); it gains no new control flow and the transition table is unchanged.
- **F2-AC10 (version immutability for in-flight runs):** GIVEN a saved workflow is edited, THEN a new version is created and any in-flight pipeline continues to use the version it started with — a running pipeline's config is never mutated (preserves determinism).

### F2 Out of scope (this spec)
- User-authored free-form agents / planner-agents that choose stages (explicitly future-work per `HANDOFF.md §3`).
- Marketplace/sharing of workflows.

---

## Cross-cutting acceptance criteria
- **X-AC1:** Neither feature modifies the v1 repo or jeopardizes the 2026-06-12 demo.
- **X-AC2:** Each milestone lands behind a feature flag and on its own BE/FE PR per the parallel-session lanes (D, E).
- **X-AC3:** Contracts (`KnowledgePort`, `IngestRecord`, `RetrievalResult`, `WorkflowConfig`, `AgentConfig`) are frozen and merged (M0) before dependent work starts.
- **X-AC4 (rollback/migration safety):** GIVEN the `knowledge_chunks` migration + RAG flag, WHEN the feature is rolled back (flag off + migration down), THEN no FSM/spine behavior changes and the demo path is unaffected; the down migration is reversible or explicitly justified as one-way.

## Open questions (must resolve before M1 code)
1. Embedding provider default → fixes `vector(N)` dimension **and** chooses the third-party data processor (privacy, see F1 non-functional).
2. Rerank cost/latency budget — Scribe path vs ASK-only (must fit the p95 < 300 ms bound).
3. Repo ingestion guardrails — full vs changed-files; max repo size. (Secret/binary exclusion is no longer open — it is mandated by F1-AC12.)
4. Prompt-variant authoring — curated/version-pinned vs raw editing.
5. Skip scope — exactly which stages/gates are user-skippable (push-gate always mandatory; gates F2-AC2).
