# AKIS MVP — Roadmap (auto-RAG & Agents/Workflows)

> Milestone plan for the two additive features in `docs/rag-and-agents-design.md` (agentic-core revision).
> **⚠️ Rebased 2026-06-01** onto the agentic core (PR #1 `feat/agentic-core-gates`, PR #2 `feat/real-providers`) — there is **no FSM transition table**; the invariant is the **4 structural gates**.
> **Timing:** post-defense. v1 demo untouched.
> **GitHub mirror:** parent roadmap issue #4 + sub-issues #5–#10.
> All milestones ship behind a feature flag and must not touch the demo path or the gate contract test.

---

## Milestone map (at a glance)

| # | Milestone | Lane | Depends on | Exit criterion |
|---|---|---|---|---|
| M0 | Frozen contracts + migration | D + E | #1 & #2 merged | Interfaces merged; `knowledge_chunks` migration reserved; no behavior |
| M1 | Auto-RAG core (`retrieve_knowledge` tool, flagged) | D (BE `knowledge/`) | M0 | ingest→retrieve round-trip + golden-eval green; tool callable by AKIS/Scribe/ASK behind flag |
| M2 | Remaining RAG sources + rerank | D | M1 | repo + upload sources live; dedup/tenancy hardened |
| M3 | Agents tab (read-only) + model picker | E (FE) | M0 | roster (AKIS+4) visible; per-agent model assigned via `/api/providers` |
| M4 | Workflow config + validation + custom agents | E (BE `workflows/`) | M0, M3 | `WorkflowConfig` versioned; validates vs roles matrix + gates + catalog |
| M5 | Workflow builder + live preview UI | E (FE) | M4 | compose/save/select; live AkisEvent preview + gate cards |

Lanes: **D** = BE `knowledge/`; **E** = BE `workflows/` + FE `features/agents/`. BE/FE always separate PRs.

---

## M0 — Frozen contracts + migration (do first, zero impl)
- [ ] `KnowledgePort` — `ingest(record: IngestRecord)`, `retrieve(query, ctx): RetrievalResult[]`
- [ ] `IngestRecord` — `{source, sourceId, userId, sessionId, agent?, commitSha?, content, contentHash, createdAt}`
- [ ] `RetrievalResult` — chunk + provenance + score
- [ ] `EmbeddingProvider` port (reuses PR #2 `KeyStore` + catalog for its key)
- [ ] `WorkflowConfig` / `AgentConfig` / `CustomAgentSpec` — typed; reference only roster roles + catalog models
- [ ] Reserve migration index for `knowledge_chunks` (`user_id` + `session_id` columns) — parallel-session reservation file
- [ ] **Blocked on D1** (#1 agentic core + `AkisEvent` bus + skill registry, #2 providers/KeyStore/`/api/providers` merged) and **D3** (embedding provider chosen → fixes `vector(N)`)
- **Exit:** interfaces merged; consumers compile against them; no behavior yet.

## M1 — Auto-RAG core (flag off)
- [ ] `knowledge/store/` — pgvector schema (`knowledge_chunks` w/ `user_id`/`session_id`) + typed repo
- [ ] `EmbeddingProvider` port + default adapter (open-decision #1; key via PR #2 KeyStore)
- [ ] `ingestQueue` — async, idempotent, content-hash dedup, **≤3 retries (1s/4s/16s) + dead-letter** (F1-AC7)
- [ ] `eventSubscriber` + `conversationSource` + `agentOutputSource` (subscribe to `events/bus.ts`, not an FSM) (F1-AC2)
- [ ] `retrieve.ts` — hybrid vector + BM25, **filtered by `user_id`** (negative cross-tenant test, F1-AC5)
- [ ] `retrieve_knowledge` **tool** registered (read-only, no gate cap) + DI-injected `KnowledgePort` (F1-AC9)
- [ ] Golden eval set (≥20 query→chunk pairs) + top-5 ≥80% quality gate (F1-AC8)
- [ ] Observability: ingest success/fail, dead-letter depth, dedup-hit, retrieval p95 (F1-AC14)
- [ ] Wire tool to AKIS/Scribe/ASK behind a feature flag; assert flag-off parity vs the gate contract test (F1-AC11)
- [ ] **Contract test:** ingest → retrieve round-trip + provenance assertion
- **Exit:** round-trip + quality-gate green; gates untouched (PR #1 contract test still passes).

## M2 — Remaining RAG sources + rerank
- [ ] `repoSource` — GitHub repo files (MockGitHubAdapter now, real later), incremental by commit
- [ ] `uploadSource` — parse PDF/markdown/text uploads
- [ ] `reranker.ts` — rerank pass (pluggable, skippable for latency-sensitive paths)
- [ ] Structure-aware chunking (code by symbol, spec by section, prose by paragraph)
- [ ] Secret/binary exclusion before embedding (F1-AC12) + dedup/tenancy hardening
- **Exit:** all sources auto-ingest with zero manual action; rerank toggleable; p95 < 300 ms.

## M3 — Agents tab (read-only) + model picker
- [ ] `features/agents/AgentsTab.tsx` — roster: **AKIS** (orchestrator) + Scribe/Proto/Trace/Critic
- [ ] `agentCard/` — each agent's base prompt + selected skills + assigned model (read-only)
- [ ] `modelPicker/` — consumes `GET /api/providers`; add/replace/remove keys via `PUT/DELETE`; per-agent model (F2-AC6) — delivers PR #2's deferred ModelPicker
- [ ] Feature-sliced contexts (no prop-drilling), i18n catalogue strings
- **Exit:** roster visible; user can manage keys + assign per-agent models. No workflow editing yet.

## M4 — Workflow config + validation + custom agents
- [ ] `workflows/workflowConfig.ts` — `WorkflowConfig` + `AgentConfig` + `CustomAgentSpec` types
- [ ] `workflows/workflowStore.ts` — versioned persistence (Drizzle); in-flight runs pin their version (F2-AC10)
- [ ] `workflows/validateWorkflow.ts` — validate vs `roles.ts` matrix + 4 gate invariants + `catalog.ts` (F2-AC4)
- [ ] `workflows/customAgents.ts` — register non-core agents (config+prompt+skills, **no gate caps**) (F2-AC3)
- [ ] Orchestrator consumes a resolved `WorkflowConfig` (enabled tools/skills/models); no new control flow (F2-AC9)
- [ ] **Tests:** producer granted verifier tool / gate disabled / unknown model → save-time error; gates stay structural
- **Exit:** workflows persisted/versioned; invalid configs rejected at save; gate contract test unchanged.

## M5 — Workflow builder + live preview UI
- [ ] `WorkflowList.tsx` — saved workflows + versions
- [ ] `WorkflowBuilder.tsx` — enable agents/tools, pre-select skills, per-agent model, gate policy (tighten-only), iterate budget, RAG settings
- [ ] `WorkflowPreview.tsx` — shows the seeded run is still gated (4 gates visible)
- [ ] `preview/LivePreview.tsx` — consumes `AkisEvent` stream: per-agent/lane step tree, gate cards, `verify`, `preview` URL (F2-AC7)
- **Exit:** user can compose/save/select a workflow and watch a run live with gates surfaced.

---

## Open decisions to resolve before M1 code
(from `docs/rag-and-agents-design.md §E`)
1. Embedding provider default (Voyage / OpenAI `text-embedding-3` / self-hosted) → fixes `vector(N)`; key via PR #2 KeyStore.
2. Rerank cost/latency budget — orchestrator/Scribe path vs ASK-only (must fit p95 < 300 ms).
3. Repo ingestion guardrails — full repo vs changed-files-only; max size. (Secret/binary exclusion settled — F1-AC12.)
4. Custom-agent capability surface — which read/compose tools a non-core agent may hold (never gate caps).
5. Workflow gate policy = tighten-only (confirm).
6. Model-selection persistence — per-workflow (recommended) vs per-session override.
