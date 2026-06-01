# AKIS MVP — Project Memory

> Durable decision + gotcha index for this repo, modeled on v1's memory index (`HANDOFF.md §10`).
> Read this first to recover context fast. Update it when a decision is made or a gotcha is found.
> Sources of truth: `HANDOFF.md` (architecture), `docs/rag-and-agents-design.md` (RAG/agents), `docs/roadmap.md` (phases).

---

## Locked architecture decisions (do NOT relitigate)
- **Keep the FSM / verification chain** — `Scribe → human gate → Proto → Validator → Critic → Trace → push-gate`. It is the thesis and the moat.
- **NOT full-agentic.** A planner-agent that invents stages is the *future-work slide*, not built. Spine stays deterministic.
- **Explicit FSM** — one `fsm/transitionTable.ts`; emit happens *inside* `transition()` (forgotten-emit becomes structurally impossible).
- **Monolith app, modular files** — single Fastify BE + single React FE; split god-files, no microservices.
- **Flexibility at the edges only** — intra-stage loops + ONE verified iterate loop + free ASK/CHAT.
- **DevAgent → labeled "unverified"** (no silent GitHub push).
- **Push gate unreachable until approved** — structural (compile-time), not per-path discipline.

## New feature decisions (2026-06-01, this branch)
- **Auto-RAG = zero-touch.** User never adds knowledge by hand. Event-driven ingestion of: conversation, pipeline outputs, GitHub repo, document uploads.
- **RAG runs server-side** (Postgres + pgvector). The "use the user's computer" idea was dropped for the simpler deterministic server path. Embedding provider is **pluggable** (a local adapter is future-work behind the same port).
- **RAG is decoupled from the orchestrator.** Standalone `knowledge/` module exposing a `retrieve()` port; stages pull via DI. Do NOT repeat v1's `applyChatMemory` coupling inside the orchestrator god-file.
- **A "workflow" = a named, versioned CONFIG over the canonical chain** — model slots, prompt variants, iterate budget, gate policy, RAG settings. NOT an arbitrary agent DAG.
- **Workflow configs validated against the transition table at save time** — illegal order / disabled mandatory gate = save error, never a runtime surprise.
- **Timing: post-defense.** v1 demo (2026-06-12) stays untouched; this is the parallel/clean hat.

## Bug-classes to design OUT (carried from v1)
1. Single source of truth for stage/SSE — backend stamps every event; no FE-synthetic rows; no 3-way derivation. **Auto-RAG subscribes to this same stream — never a parallel channel.**
2. No dual render paths — one canonical row builder.
3. Forgotten-emit impossible — emit inside `transition()`.
4. Typed cross-stage state — no untyped `intermediateState` bag. (Same rule for `IngestRecord` / `WorkflowConfig`.)
5. Explicit FSM — no scattered `store.update`.
6. One verification-chain runner — never 5 copies.
7. i18n lint gate — no hardcoded Turkish (applies to the Agents tab too).
8. Push gate unreachable until approved.

## Parallel-session ownership lanes
- A = BE `orchestrator/fsm` + lifecycle · B = BE `stages/` + `agents/` · C = FE `features/chat`
- **D = BE `knowledge/`** (auto-RAG) · **E = BE `workflows/` + FE `features/agents/`** (agents/workflows)
- Freeze cross-session contracts BEFORE dispatch: `TransitionCtx`, `Stage`, `OrchestratorServices`, `ChatScreen`, the 3 FE contexts, plus `KnowledgePort`, `IngestRecord`, `RetrievalResult`, `WorkflowConfig`, `AgentConfig`.
- BE/FE always separate PRs. Per-session port/DB isolation via `dev-up.sh --session N`.

## Gotchas / watch-outs
- v1 `intermediateState` was an untyped `Record<string,unknown>` read-modify-written in 4+ files → silent no-ops 3 stages away. Always type cross-stage state.
- v1 orchestrator `emit` callback was wired to `undefined`; real SSE flowed via a separate `pipelineBus` → "refresh gerekiyor" complaints. One stream only.
- v1 had a parallel Proto path (iteration mode) that skipped Validator+Critic+Trace. Never reintroduce a verification-bypass path.
- Claude is a generation model, not an embedding model — RAG needs a dedicated `EmbeddingProvider` (Voyage / OpenAI text-embedding-3 / self-hosted).
- pgvector dimension is fixed by the chosen embedding model → decide the provider before writing the migration.

## Status
- Design docs + roadmap committed on `claude/akis-agents-rag-system-NDTAH` (PR #3).
- No implementation yet — M0 (frozen contracts) is the next concrete step, after the 5 open decisions in `docs/roadmap.md` are resolved.
