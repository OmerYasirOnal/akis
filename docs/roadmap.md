# AKIS MVP — Roadmap (auto-RAG & Agents/Workflows)

> Milestone/phase plan for the two additive features designed in `docs/rag-and-agents-design.md`.
> **Timing:** post-defense (after 2026-06-12). v1 demo stays untouched; work proceeds on the MVP clean hat.
> **GitHub mirror:** tracked as a parent roadmap issue + one sub-issue per milestone (see links once created).
> All milestones ship behind a feature flag and must not touch the demo path or the in-flight spine refactor.

---

## Milestone map (at a glance)

| # | Milestone | Lane | Depends on | Exit criterion |
|---|---|---|---|---|
| M0 | Frozen contracts | D + E | — | Interfaces published & merged; no impl |
| M1 | Auto-RAG ingestion + retrieval (flagged) | D (BE `knowledge/`) | M0 | ingest→retrieve round-trip green; Scribe+ASK read behind flag |
| M2 | Remaining RAG sources + rerank | D | M1 | repo + upload sources live; dedup/idempotency hardened |
| M3 | Agents tab (read-only) | E (FE) | M0 | 5 agents + current config/prompts visible; no editing |
| M4 | Workflow config + validation | E (BE `workflows/`) | M0, M3 | `WorkflowConfig` persisted/versioned; validates vs transition table |
| M5 | Workflow builder UI | E (FE) | M4 | compose/save/select; preview renders verified-chain subset; per-workflow RAG settings |

Lanes (from `HANDOFF.md §7`): **D** = BE `knowledge/`; **E** = BE `workflows/` + FE `features/agents/`. BE/FE always separate PRs.

---

## M0 — Frozen contracts (do first, zero impl)
Publish and merge the shared interfaces so D and E can proceed without colliding.
- [ ] `KnowledgePort` — `ingest(record: IngestRecord)`, `retrieve(query, ctx): RetrievalResult[]`
- [ ] `IngestRecord` — `{source, sourceId, workflowId, stage?, commitSha?, content, contentHash, createdAt}`
- [ ] `RetrievalResult` — chunk + provenance + score
- [ ] `WorkflowConfig` / `AgentConfig` — typed, references only legal stages
- [ ] Reserve migration index for `knowledge_chunks` (parallel-session reservation file)
- **Exit:** interfaces merged to the MVP base; consumers compile against them; no behavior yet.

## M1 — Auto-RAG ingestion + retrieval (flag off)
- [ ] `knowledge/store/` — pgvector schema (`knowledge_chunks`) + typed repo
- [ ] `EmbeddingProvider` port + default adapter (provider decided in open-decision #1)
- [ ] `ingestQueue` — async, idempotent, content-hash dedup, retry budget
- [ ] `conversationSource` + `pipelineSource` (subscribe to backend-stamped event bus)
- [ ] `retrieve.ts` — hybrid vector + BM25 recall
- [ ] Wire `retrieve()` into Scribe + ASK behind a feature flag (prompt augmentation only)
- [ ] **Contract test:** ingest → retrieve round-trip + provenance assertion
- **Exit:** round-trip test green; Scribe/ASK read retrieval behind the flag; FSM untouched.

## M2 — Remaining RAG sources + rerank
- [ ] `repoSource` — GitHub repo files via existing GitHub MCP, incremental by commit
- [ ] `uploadSource` — parse PDF/markdown/text uploads
- [ ] `reranker.ts` — rerank pass (pluggable, skippable for latency-sensitive paths)
- [ ] Structure-aware chunking (code by symbol, spec by section, prose by paragraph)
- [ ] Dedup/idempotency hardening + workflow-scoped tenancy checks
- **Exit:** all four sources auto-ingest with zero manual action; rerank toggleable.

## M3 — Agents tab (read-only)
- [ ] `features/agents/AgentsTab.tsx` — lists the 5 agents (Scribe/Proto/Validator/Critic/Trace)
- [ ] `agentCard/` — shows each agent's current model slot + prompt variant (read-only)
- [ ] Feature-sliced contexts (no prop-drilling), i18n catalogue strings
- **Exit:** agents + their config/prompts visible; no editing yet (de-risks the UI).

## M4 — Workflow config + validation
- [ ] `workflows/workflowConfig.ts` — `WorkflowConfig` + `AgentConfig` types
- [ ] `workflows/workflowStore.ts` — versioned persistence (Drizzle)
- [ ] `workflows/validateWorkflow.ts` — validate against `fsm/transitionTable.ts`
- [ ] Orchestrator consumes a resolved `WorkflowConfig` as input (no new control flow)
- [ ] **Tests:** illegal stage order / disabled mandatory gate → save-time validation error; push-gate always required
- **Exit:** workflows persisted/versioned; invalid configs rejected at save, not runtime.

## M5 — Workflow builder UI
- [ ] `WorkflowList.tsx` — saved workflows + versions
- [ ] `WorkflowBuilder.tsx` — toggle stages, set model/prompt/iterate-budget/gate-policy
- [ ] `WorkflowPreview.tsx` — renders the resulting canonical-chain subset (read-only)
- [ ] Per-workflow RAG settings (which sources, rerank on/off)
- **Exit:** user can compose/save/select a workflow; preview shows it is a verified-chain subset.

---

## Open decisions to resolve before M1 code
(from `docs/rag-and-agents-design.md §E`)
1. Embedding provider default (Voyage / OpenAI `text-embedding-3` / self-hosted) → fixes `vector(N)` dimension.
2. Rerank cost/latency budget — LLM-judge on Scribe path, or ASK-only?
3. Repo ingestion guardrails — full repo vs changed-files-only; binary exclusion; max size.
4. Prompt-variant authoring — curated/version-pinned variants (recommended) vs raw editing.
5. Skip scope — exactly which stages/gates are user-skippable (push-gate always mandatory).
