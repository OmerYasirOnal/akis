# Spec — Auto-RAG & Agents/Workflows (agentic-core revision)

> **Type:** requirements spec (what + acceptance criteria). Design: `docs/rag-and-agents-design.md`; phases: `docs/roadmap.md`.
> **⚠️ Revised 2026-06-01** onto the **agentic core** (PR #1 `feat/agentic-core-gates`, PR #2 `feat/real-providers`), replacing the FSM assumptions. Independent review history: `specs/review/`.
> **Vocabulary:** milestones `M0`–`M5`. "AKIS" = the main orchestrator agent's display name (role `orchestrator`).

---

## 0. Source requests (verbatim intent)
1. *Auto-RAG:* a retrieval system that **auto-ingests** (zero manual user action), high-quality, server-side.
2. *Agents tab + workflows:* compose workflows like Claude Code, **but** (user, 2026-06-01): keep **Scribe/Proto/Trace** sub-agents and a **single main orchestrator agent named "AKIS"**; allow **extra/custom agents** and extra capabilities; a **proper preview-screen UI/UX**; and the user must **pick their own API keys — including keys from other providers — via a model picker** (the tooling that runs behind Claude Code). PR #2 already provides the backend for this.

Reconciliation decisions (confirmed with user):
- Substrate = **agentic core + 4 structural gates**, NOT an FSM (per PR #1 §0). The gates are inviolable.
- Timing = post-defense; v1 untouched. RAG = server-side pgvector.
- Workflow = a **preset that seeds/bounds an agentic run** (enabled agents/tools/skills, per-agent model, gate policy, RAG settings), validated against the **role/tool permission matrix + gate invariants + model catalog** — not an FSM transition table.
- Auto-ingest corpus = conversation + agent outputs (spec/code) + verification results + GitHub repo + uploads.
- Tenancy key = `user_id` + `session_id`. Privacy posture = **exclude-then-embed** (secrets/binaries excluded; broader PII redaction deferred for the single-user MVP).

## Dependencies (must exist before dispatch)
- **D1:** PR #1 (agentic orchestrator + sub-agents + 4 gates + `AkisEvent` bus + skill registry) and PR #2 (`LlmProvider`/`createProvider`/`catalog`/encrypted `KeyStore`/`/api/providers`) merged.
- **D1b — Core Foundations (NEW, per `docs/architecture-review.md`):** a code review found several seams our plan assumed are **not built yet**. Each milestone depends on its Core Foundation (owned by the agentic-core lanes, coordinated, not assumed):
  - **CF1** orchestrator HTTP routes + SSE endpoint → blocks live preview (M5) + usability.
  - **CF2** real provider-backed sub-agents + agent-loop/tool-dispatch seam + emit `tool_call`/`tool_result`/`preview` → blocks RAG-as-a-tool (M1), live UI (M5).
  - **CF3** per-agent provider/model wiring → blocks the model picker binding (M3).
  - **CF4** data-driven roles + permission matrix + agent registry → blocks custom agents / workflow presets (M4).
  - **CF5** resumable event stream (per-session monotonic `seq` + buffer + `Last-Event-ID`) → blocks reliable live preview (M5).
  - **CF6** core hardening (confirmPush atomicity, verify-capability wrap, fail-closed providers) → serves "flawless operation".
  - **Fallback** if a CF isn't ready: RAG ships as a **DI service** (agent calls it directly) not an LLM tool; model picker ships **read-only** until CF3.
- **D2:** Auth / user identity available to stamp `user_id` (`F1-AC5`).
- **D3:** Embedding provider chosen (open question #1) before the `knowledge_chunks` migration freezes (`vector(N)`).

---

## FEATURE 1 — Auto-RAG (zero-touch knowledge layer)

### F1 User stories
- **F1-US1** I never manually add knowledge; everything the platform touches becomes retrievable automatically.
- **F1-US2** AKIS/Scribe can retrieve relevant prior context so outputs are grounded in the project's own history and code.
- **F1-US3** In ASK/CHAT I get answers grounded in my project, with citations.

### F1 Acceptance criteria
- **F1-AC1 (zero-touch ingest):** GIVEN a new conversation message, agent output (`SessionState.spec`/`.code`), verification result, connected repo, or uploaded document, WHEN persisted/emitted, THEN its content is ingested **without any manual user action**.
- **F1-AC2 (event-driven, single source):** Ingestion is triggered by subscribing to the **`AkisEvent` bus** (`events/bus.ts`), whose events are backend-stamped (`ts`). No polling; no FE-synthesized ingestion events; no re-derivation of state.
- **F1-AC3 (idempotent):** Re-ingesting identical content (replay/re-run) creates no duplicate vectors (content-hash dedup).
- **F1-AC4 (provenance):** Every chunk carries server-stamped `{source, sourceId, userId, sessionId, agent?, commitSha?, createdAt}`; retrieval results expose this provenance.
- **F1-AC5 (tenancy isolation):** Retrieval is filtered by `user_id` (+ `session_id` scope) in the query layer. GIVEN a chunk owned by user A, WHEN user B retrieves, THEN A's chunk is never returned. Enforced by SQL predicate + an automated **negative** test.
- **F1-AC6 (server-side):** Embedding + vector storage run server-side (Postgres + pgvector). No client/desktop component required.
- **F1-AC7 (non-blocking + bounded failure):** Ingestion is async, off the agent path. **≤3 retries, backoff 1s/4s/16s.** On budget exhaustion → **dead-letter** state, observable (metric + log), **never silently dropped**; the agent run completes regardless of embed outcome.
- **F1-AC8 (retrieval quality — measurable):** A versioned **golden eval set** (≥20 `query → expected-chunk` pairs over a seeded corpus) lives in the repo; retrieval (hybrid vector + BM25, optional rerank) places the expected chunk in **top-5 for ≥80%** of queries, asserted in CI. ("Best-in-class" = meets/raises this bar.)
- **F1-AC9 (retrieval = a tool, decoupled):** Retrieval is exposed as a `retrieve_knowledge` **tool** in the registry (callable by `orchestrator`/`scribe`/ASK), backed by a DI-injected `KnowledgePort.retrieve()`. The orchestrator does not wire the knowledge internals (no `applyChatMemory`-style coupling). The tool is **read-only and holds no gate capability**.
- **F1-AC10 (gates untouched):** RAG augments prompts/answers only; it adds no input to any gate and changes no gate behavior. No knowledge code imports a gate minter.
- **F1-AC11 (flagged + tested both ways):** RAG behind a feature flag; with the flag off, agent/gate behavior is identical to no-RAG, asserted by the gate contract/smoke test toggled both ways.
- **F1-AC12 (secret/binary exclusion):** Repo/upload content matching the secret denylist (`.env`, keys) or a binary type is **excluded before embedding** and the exclusion is logged. Prerequisite for repoSource/uploadSource, not deferred.
- **F1-AC13 (deletion / right-to-forget):** Deleting a conversation, session, or upload deletes/tombstones its chunks; idempotent re-deletion is a no-op.
- **F1-AC14 (observability):** Exposes ingest success/failure counts, dead-letter/queue depth, dedup-hit rate, retrieval latency — queryable without code changes.
- **F1-AC15 (re-index on model change):** Changing the embedding provider/dimension has a defined re-index path; `vector(N)` and `vector(M)` chunks are never mixed at query time.
- **F1-AC16 (citation integrity):** A cited chunk whose source was deleted/superseded resolves to a valid state or is marked stale (no dangling citations).
- **F1-AC17 (ingestion subscription):** A global ingestion sink subscribes per session as sessions start (the bus `subscribe` is per-session only); no event is missed between session start and subscription.

### F1 Non-functional
- `EmbeddingProvider` is a pluggable port that **reuses PR #2's `KeyStore` + catalog** (no second key system). Default = open question #1; vector dimension follows the model. **Privacy:** the default provider receives all ingested content as a 3rd-party processor — acceptable for single-user MVP, stated to the user, revisited if multi-tenant.
- **Performance:** retrieval **p95 < 300 ms** on ≤50k chunks; rerank skippable on latency-sensitive paths.

### F1 Out of scope
- Local/on-device embedding (future behind the port); knowledge-curation UI (auto-only); PII redaction beyond secret/binary exclusion.

---

## FEATURE 2 — Agents & Workflows tab

### F2 User stories
- **F2-US1** I can see + configure AKIS (orchestrator) and Scribe/Proto/Trace/Critic.
- **F2-US2** I can add **extra/custom agents** and assemble, name, version, and select a **workflow** that seeds an agentic run.
- **F2-US3** I can **pick my own API keys (incl. other providers) and assign a model per agent** via a model picker.
- **F2-US4** I can watch a run live in a **proper preview screen** (timeline + gates + preview).

### F2 Acceptance criteria
- **F2-AC1 (workflow = bounded preset):** A workflow is a typed, versioned `WorkflowConfig`: enabled agents/tools, pre-selected skills per agent, per-agent model `{providerId, modelId}`, gate policy, iterate budget, RAG settings. It seeds/bounds the orchestrator's run; it cannot define arbitrary stage graphs or new control flow.
- **F2-AC2 (core roster, structural):** AKIS + Scribe/Proto/Trace/Critic are code-defined roles (`roles.ts`); the gates key on them. They are configurable (model, skills, base-prompt variant) but not redefinable/removable.
- **F2-AC3 (custom agents — no gate capability):** A user may add extra agents via config + base prompt + skills. A custom agent is a **non-core role** that may hold read/compose tools but **cannot** be the verifier, **cannot** receive `run_tests`/`push_to_github`, and **cannot** mint approval/push tokens. Attempting to grant a gate capability to a custom agent is rejected.
- **F2-AC4 (validation vs matrix + gates + catalog):** GIVEN a `WorkflowConfig`, WHEN saved, THEN it is validated against the role/tool permission matrix (`roles.ts`), the 4 gate invariants, and the model catalog; any violation (producer granted verifier tool, a gate disabled, an unknown `{providerId, modelId}`) is **rejected at save time** with a clear error — never a runtime surprise.
- **F2-AC5 (gates inviolable):** No `WorkflowConfig` can disable or loosen the 4 structural gates (spec-approval, producer≠verifier, verified=real-test, push). Gate policy is **tighten-only** (may add required gates, e.g. mandatory critic resolution).
- **F2-AC6 (model picker on PR #2):** The tab reads `GET /api/providers`; lets the user add/replace/remove keys via `PUT/DELETE /api/providers/:provider/key` (encrypted at rest, `last4`-only display, key never echoed); and assigns a model per agent persisted in the `WorkflowConfig`. Includes providers beyond Anthropic (OpenAI/OpenRouter/Gemini per catalog).
- **F2-AC7 (live preview):** A preview screen consumes the `AkisEvent` stream and renders a live, possibly-parallel step tree (per `agent` + `laneId`), gate moments as first-class approve/confirm cards, `verify` results, and the `preview` event URL in a dedicated pane.
- **F2-AC8 (read-only first):** The Agents tab ships first as read-only roster + model picker (M3); workflow building + live preview arrive in M4/M5.
- **F2-AC9 (orchestrator input):** The orchestrator consumes a resolved `WorkflowConfig` (enabled tools/skills/models) at session start; it gains no new control flow; `roles.ts` and the gates are unchanged.
- **F2-AC10 (version immutability for in-flight runs):** Editing a saved workflow creates a new version; an in-flight run keeps the version it started with (config never mutated mid-run).
- **F2-AC11 (i18n + no prop-drilling):** All user-facing strings via the i18n catalogue (TR+EN), CI lint gate; the FE feature uses feature-sliced contexts, not a prop bag.
- **F2-AC12 (resumable live stream):** The live preview survives refresh/reconnect with **no lost or duplicated steps** — backed by a per-session monotonic `seq` + `Last-Event-ID` resume + a server buffer with an overflow signal (CF5).
- **F2-AC13 (bounded agent loop):** Every agentic run has a hard step/iterate cap (generalize the existing `MAX_ITERATE`) **and** a wall-clock budget; exceeding either ends the run as `failed` with a typed reason — never an unbounded loop.
- **F2-AC14 (least-privilege tool scope):** A `WorkflowConfig` grants each agent the **minimum** tool set; a tool not in the workflow is not dispatchable for that run.
- **F2-AC15 (observability):** Core + RAG emit OpenTelemetry-style spans/metrics (run/step latency, tokens, gate events, ingest/retrieval health) queryable without code changes.
- **F2-AC16 (shared context environment):** All agents read a typed `SharedContext` = `SessionState` + the `AkisEvent` log + retrieved knowledge (`KnowledgePort.retrieve()`) + a typed cross-agent scratchpad. The **only** write path is typed events/returns — no untyped shared blob (v1's `intermediateState` mistake).
- **F2-AC17 (AKIS dispatch with context):** AKIS (the main orchestrator agent) dispatches every agent (core + custom) with a read view of `SharedContext`; a dispatched agent never reaches a gate capability it isn't entitled to.

### CORE acceptance criteria (owned by the agentic-core session; we depend on them)
- **CORE-AC1 (live agents):** every core sub-agent (Scribe/Proto/Trace) produces its artifact via a **real provider call** (asserted by a test that the provider was invoked), not a hardcoded literal — closes the "sub-agents are stubs" gap (CF2).
- **CORE-AC2 (default Claude, live by default):** with `ANTHROPIC_API_KEY` present (env or KeyStore) and no other config, all agents run on Claude; with nothing configured outside `NODE_ENV=test`, the system **fails loudly** (no silent mock fallback) (CF6).
- **CORE-AC3 (no committed keys):** the default Claude API key comes from env/KeyStore only; a secret-scan/CI check asserts no key material is ever committed; default key-store path is outside the repo.

### F2 Out of scope
- Planner-agent that invents stages / fully free agent DAG authoring beyond the bounded preset.
- Marketplace/sharing of workflows; streaming UI polish beyond the live event tree.

---

## Cross-cutting acceptance criteria
- **X-AC1:** Neither feature modifies the v1 repo or jeopardizes the 2026-06-12 demo.
- **X-AC2:** Each milestone behind a feature flag, on its own BE/FE PR (lanes D, E).
- **X-AC3:** Contracts (`KnowledgePort`, `IngestRecord`, `RetrievalResult`, `EmbeddingProvider`, `WorkflowConfig`, `AgentConfig`, `CustomAgentSpec`) frozen + merged (M0) before dependent work.
- **X-AC4 (rollback/migration safety):** Flag off + `knowledge_chunks` migration down → no agent/gate behavior change, demo path unaffected; down migration reversible or explicitly justified.
- **X-AC5 (gate contract test stays green):** The PR #1 4-gate contract test (Scenarios A–F) must pass **unchanged** after both features land — proof neither touched the gates.
- **X-AC6 (fail-closed providers):** Outside `NODE_ENV=test`, a misconfigured provider/key fails loudly; the mock never silently produces "verified" output in production (CF6).

## Open questions (resolve before M1 code)
1. Embedding provider default → `vector(N)` + 3rd-party processor (reuse KeyStore).
2. Rerank budget within p95 < 300 ms (orchestrator/Scribe path vs ASK-only).
3. Repo ingestion guardrails — full vs changed-files; max size. (Secret/binary exclusion settled — F1-AC12.)
4. Custom-agent capability surface — which read/compose tools a non-core agent may hold (never gate caps).
5. Workflow gate policy = tighten-only (confirm).
6. Model-selection persistence — per-workflow (recommended) vs per-session override.
