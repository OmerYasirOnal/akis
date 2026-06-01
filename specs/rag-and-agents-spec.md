# Spec — Auto-RAG & Agents/Workflows

> **Type:** requirements spec (what + acceptance criteria), not a design. Design lives in `docs/rag-and-agents-design.md`; phases in `docs/roadmap.md`.
> **Captures:** the user's two requests from 2026-06-01, reconciled with the locked architecture in `HANDOFF.md`.
> **Status:** draft → under independent review (see `specs/review/` for the zero-context review + responses).

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

---

## FEATURE 1 — Auto-RAG (zero-touch knowledge layer)

### F1 User stories
- **F1-US1** As a user, I never manually add knowledge; everything the platform touches becomes retrievable automatically.
- **F1-US2** As the Scribe stage, I retrieve relevant prior context so my specs are grounded in the project's own history and code.
- **F1-US3** As a user in ASK/CHAT, I get answers grounded in my project, with citations to where each fact came from.

### F1 Acceptance criteria
- **F1-AC1 (zero-touch ingest):** GIVEN a new conversation message, pipeline `StageOutcome`, connected repo, or uploaded document, WHEN it is persisted, THEN its content is ingested into the knowledge store **without any manual user action**.
- **F1-AC2 (event-driven, single source):** Ingestion is triggered by the **same backend-stamped event stream** the FSM emits. No polling; no FE-synthesized ingestion events.
- **F1-AC3 (idempotent):** GIVEN identical content is ingested twice (replay/re-run), THEN no duplicate vectors are created (content-hash dedup).
- **F1-AC4 (provenance):** Every stored chunk carries server-stamped `{source, sourceId, workflowId, stage?, commitSha?, createdAt}`; retrieval results expose this provenance.
- **F1-AC5 (scoping):** Retrieval is scoped to the requesting user's workspace + workflow by default; cross-workflow access is explicit, never accidental.
- **F1-AC6 (server-side):** Embedding generation + vector storage run server-side (Postgres + pgvector). No client/desktop component is required for the feature to work.
- **F1-AC7 (non-blocking):** A slow or failing embed never stalls or fails an FSM stage transition (ingestion is async, off the critical path, with a retry budget).
- **F1-AC8 (retrieval quality):** Retrieval uses hybrid recall (vector + keyword/BM25) with an optional rerank pass; results are ordered by relevance.
- **F1-AC9 (decoupling):** The orchestrator does not wire the knowledge subsystem; stages obtain retrieval via a DI-injected `KnowledgePort.retrieve()`. (Designs out v1's `applyChatMemory` coupling.)
- **F1-AC10 (spine untouched):** RAG augments prompts only; it adds no input to the FSM transition table and changes no gate behavior.
- **F1-AC11 (flagged):** RAG is behind a feature flag; with the flag off, pipeline behavior is identical to no-RAG.

### F1 Non-functional
- Embedding provider is pluggable (`EmbeddingProvider` port); default decided in open-decision #1. Vector dimension follows the chosen model.
- Ingestion throughput must keep up with normal pipeline event volume without backlog under typical single-user load.

### F1 Out of scope (this spec)
- Local/on-device embedding or indexing (future-work behind the same port).
- Knowledge editing/curation UI (auto-only by design).

---

## FEATURE 2 — Agents & Workflows tab

### F2 User stories
- **F2-US1** As a user, I can see the agents (Scribe/Proto/Validator/Critic/Trace) and their current configuration.
- **F2-US2** As a user, I can assemble, name, save, and version a **workflow** that tunes the verified chain.
- **F2-US3** As a user, when I build a workflow I can see it is still a verified pipeline (preview renders the canonical-chain subset).

### F2 Acceptance criteria
- **F2-AC1 (config, not DAG):** A workflow is a named, versioned configuration over the canonical chain (`Scribe → gate → Proto → Validator → Critic → Trace → push-gate`). The UI cannot define new agents or arbitrary stage graphs.
- **F2-AC2 (configurable fields):** Per agent: model slot, prompt variant, enable/skip where legal. Per workflow: iterate budget, gate policy, RAG settings, name + version.
- **F2-AC3 (validated against FSM):** GIVEN a workflow config, WHEN saved, THEN it is validated against `fsm/transitionTable.ts`; an illegal stage order or a disabled mandatory gate is **rejected at save time** with a clear error — never a runtime surprise.
- **F2-AC4 (push-gate inviolable):** No workflow config can disable or bypass the push-confirm gate; push stays structurally unreachable until human approval, regardless of config.
- **F2-AC5 (read-only first):** The Agents tab ships first as read-only (M3); editing/building arrives in later milestones (M4/M5).
- **F2-AC6 (preview):** The builder renders the resulting pipeline as a subset/parameterization of the canonical chain, communicating "you are tuning a verified pipeline."
- **F2-AC7 (i18n):** All user-facing strings go through the i18n catalogue (TR+EN); CI lint gate fails on hardcoded strings.
- **F2-AC8 (no prop-drilling):** The FE feature uses the feature-sliced context discipline, not a prop bag.
- **F2-AC9 (orchestrator input):** The orchestrator consumes a resolved `WorkflowConfig` as input; it gains no new control flow and the transition table is unchanged.

### F2 Out of scope (this spec)
- User-authored free-form agents / planner-agents that choose stages (explicitly future-work per `HANDOFF.md §3`).
- Marketplace/sharing of workflows.

---

## Cross-cutting acceptance criteria
- **X-AC1:** Neither feature modifies the v1 repo or jeopardizes the 2026-06-12 demo.
- **X-AC2:** Each milestone lands behind a feature flag and on its own BE/FE PR per the parallel-session lanes (D, E).
- **X-AC3:** Contracts (`KnowledgePort`, `IngestRecord`, `RetrievalResult`, `WorkflowConfig`, `AgentConfig`) are frozen and merged (M0) before dependent work starts.

## Open questions (must resolve before M1 code)
1. Embedding provider default → fixes `vector(N)` dimension.
2. Rerank cost/latency budget — Scribe path vs ASK-only.
3. Repo ingestion guardrails — full vs changed-files; binary exclusion; max repo size.
4. Prompt-variant authoring — curated/version-pinned vs raw editing.
5. Skip scope — exactly which stages/gates are user-skippable (push-gate always mandatory).
