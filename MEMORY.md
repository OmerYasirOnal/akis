# AKIS MVP — Project Memory

> Durable decision + gotcha index for this repo, modeled on v1's memory index (`HANDOFF.md §10`).
> Read this first to recover context fast. Update it when a decision is made or a gotcha is found.
> Sources of truth: `HANDOFF.md` (architecture), `docs/rag-and-agents-design.md` (RAG/agents), `docs/roadmap.md` (phases).

---

## ⚠️ ARCHITECTURE PIVOT (2026-06-01) — read this first
The original handoff's **FSM / transition table** decision was **consciously reversed** by the product owner. The MVP being built is **agentic**, not an FSM. Source of truth = `docs/superpowers/specs/2026-06-01-agentic-core-gates-design.md §0`.
- **Flow is agentic:** a single **main orchestrator agent ("AKIS", role `orchestrator`)** decides which sub-agents/skills to dispatch and when. **No `fsm/transitionTable.ts` exists.**
- **The thesis ("quality trust") is preserved by 4 STRUCTURAL GATES** (branded tokens, not the agent's choice), enforced at the type/permission layer:
  1. **Spec-approval** — `ProtoAgent` needs an `ApprovedSpec`/`ApprovalToken`; code-write can't type-check without human approval.
  2. **Producer ≠ verifier** — only the `trace` (verifier) role holds a `TestRunner`; producers can't produce verification evidence.
  3. **Verified = real test** — verification is the *presence* of a branded `VerifyToken` (≥1 executed+passing test); can't be set as a literal.
  4. **Push gate** — `pushToGitHub` needs an `ApprovedPush`, mintable only from a `VerifyToken` + human confirm + matching code digest.
- **Roster** = `orchestrator/scribe/proto/trace/critic` in code; **extensible by config + prompt** for extra agents — but custom agents can NEVER hold a gate capability (verifier/run_tests/push/token mint).
- **Substrate already built:** PR #1 (`feat/agentic-core-gates`) = agentic core + 4 gates + `AkisEvent` bus + skill registry + DeterministicValidator/Critic ported, mock provider. PR #2 (`feat/real-providers`) = 4 real providers behind `LlmProvider`, `createProvider`, model `catalog.ts`, encrypted `KeyStore`, `GET/PUT/DELETE /api/providers` (the model-picker backend; FE picker deferred → our Agents tab).
- **Defense (2026-06-12) still runs on v1** (which has the FSM) → the pivot carries no defense risk; MVP is parallel/post-defense.

## Carried-over decisions (still hold under the pivot)
- **Monolith app, modular files** — single Fastify BE + single React FE; `backend/ + frontend/ + shared/` workspace; `shared/` = frozen contracts.
- **Gates inviolable, structural (compile-time), never disabled by config.** This replaces "push gate unreachable until approved" — same spirit, broader.
- **Single source of truth for events** — the `AkisEvent` bus, backend-stamped `ts`; no FE-synthetic events.
- **Typed contracts, no untyped bags** — `SessionState`, `IngestRecord`, `WorkflowConfig` all typed.
- Stack kept: Fastify 4 + TS strict + Drizzle + Postgres 16 (pgvector) + React 19 + Vite 7 + Tailwind v4.

## New feature decisions (2026-06-01, this branch — agentic-core revision)
- **Auto-RAG = zero-touch.** User never adds knowledge by hand. Ingestion subscribes to the **`AkisEvent` bus** (not an FSM): conversation `text`, agent outputs (`SessionState.spec`/`.code`), `verify`/Critic results, GitHub repo, uploads.
- **Retrieval = a `retrieve_knowledge` TOOL** in the registry (callable by AKIS/Scribe/ASK), backed by a DI-injected `KnowledgePort`. Read-only, no gate capability. Decoupled — orchestrator never imports knowledge internals.
- **RAG runs server-side** (Postgres + pgvector). "Use the user's computer" dropped. `EmbeddingProvider` is a pluggable port that **reuses PR #2's `KeyStore` + catalog** (no second key system).
- **A "workflow" = a bounded, versioned PRESET that SEEDS an agentic run** — enabled agents/tools, pre-selected skills per agent, per-agent model `{providerId, modelId}`, gate policy (tighten-only), iterate budget, RAG settings. NOT a config-over-FSM and NOT an arbitrary DAG. The orchestrator still decides flow at runtime; the preset only seeds/bounds it.
- **Workflow validated at save time vs the role/tool permission matrix (`roles.ts`) + the 4 gate invariants + the model catalog** — producer-granted-verifier / gate-disabled / unknown-model = save error. (This replaces "validate against transition table".)
- **Model picker = our FE home for PR #2's deferred ModelPicker** — consumes `GET /api/providers` + `PUT/DELETE key`; user picks own/other-provider keys; per-agent model.
- **Live preview screen** consumes the `AkisEvent` stream (per-agent/lane step tree + gate cards + `preview` URL).
- **Timing: post-defense.** v1 demo (2026-06-12) stays untouched.

## Bug-classes to design OUT
1. Single source of truth — the `AkisEvent` bus (backend-stamped `ts`); no FE-synthetic events. **Auto-RAG subscribes to this same bus — never a parallel channel.**
2. Typed contracts — `SessionState`, `IngestRecord`, `WorkflowConfig` all typed; no untyped bags.
3. Gates structural, never config-disabled — the 4 gates are code-defined; custom agents can't hold gate caps.
4. RAG decoupled — no `applyChatMemory`-style coupling inside the orchestrator (DI + tool only).
5. i18n lint gate — no hardcoded Turkish (applies to the Agents tab + live preview).
6. The PR #1 4-gate contract test (Scenarios A–F) must stay green after our features land (proof we didn't touch the gates).

## Parallel-session ownership lanes
- In-flight: PR #1 `feat/agentic-core-gates`, PR #2 `feat/real-providers`.
- **D = BE `knowledge/`** (auto-RAG: ingestion/retrieval/store + `retrieve_knowledge` tool) · **E = BE `workflows/` + FE `features/agents/`** (roster, workflow presets, model picker, live preview).
- Shared (read-only) surfaces D/E consume: `roles.ts`, `catalog.ts`, gates, `events/bus.ts`, `di/services.ts`, `/api/providers`.
- Freeze before dispatch: `KnowledgePort`, `IngestRecord`, `RetrievalResult`, `EmbeddingProvider`, `WorkflowConfig`, `AgentConfig`, `CustomAgentSpec`. BE/FE separate PRs.

## Gotchas / watch-outs
- **No FSM exists** — anything referencing `fsm/transitionTable.ts` from the original plan is stale. Validate workflows against `roles.ts` + gates instead.
- Claude is a generation model, not embeddings — RAG needs a dedicated `EmbeddingProvider` (Voyage / OpenAI text-embedding-3 / self-hosted); reuse the KeyStore for its key.
- pgvector dimension fixed by the embedding model → decide the provider before the migration.
- Custom/extra agents must NOT be grantable any gate capability (verifier / `run_tests` / `push_to_github` / token mint) — validate this at save time.
- Loop default model is `claude-haiku-4-5-20251001` (cost/quota guard); catalog is the single source of model IDs.
- v1 lessons still apply: never reintroduce a verification-bypass path; one event stream only.

## Architecture review findings (2026-06-01 — `docs/architecture-review.md`)
A deep code review of `feat/real-providers` found:
- **Gate kernel = sound** (real brands, digest binding, contract test drives the real path). Build on it.
- **"Agentic" is hollow:** no agent loop; Scribe/Proto are **stubs that never call an LLM** (only Critic does) → real spec/code output is still fake. `tool_call`/`tool_result`/`preview` events never emitted.
- **No delivery surface:** no orchestrator HTTP routes, **no SSE endpoint** — core is unreachable/unobservable over the wire.
- **Dynamic mgmt partial:** provider/model + skills dynamic; but **`Role` is a closed union, no permission matrix**, agents hardcoded in DI (no registry), flow is imperative, **no tool registry** → my `retrieve_knowledge` tool has nothing to register into yet.
- **Stream not resumable:** events carry counter `ts`, not per-session `seq`; buffer capped 200, no persistence → UI loses events on refresh.
- **Correctness nits:** `confirmPush` concurrent **double-push window**; exported `createVerifier` + public `recordVerification` = same-realm capability gap; `createProvider` **fails open to mock** in prod on misconfig.
- **→ Core Foundations CF1–CF6** added as upstream prerequisites (owned by core lanes A/B); my M1/M3/M4/M5 depend on them. Fallbacks: RAG as DI service (not tool), model picker read-only, until the CF lands.
- **New ACs:** F1-AC17 (per-session ingest subscription), F2-AC12 (resumable stream), F2-AC13 (bounded loop), F2-AC14 (least-privilege tool scope), F2-AC15 (observability), X-AC6 (fail-closed providers).

## Owner requirements (2026-06-01) + coordination (`docs/coordination-notes.md`)
- **Default Claude provider — live by default.** Anthropic is the DEFAULT provider so every agent (AKIS + Scribe/Proto/Trace/Critic) runs on a real model out of the box. Mock only for `NODE_ENV=test` / explicit opt-in. **Key from env (`ANTHROPIC_API_KEY`) or KeyStore — NEVER hardcoded/committed.** Loop default model `claude-haiku-4-5`; model picker overrides per agent.
- **Live agents (CF2):** Scribe/Proto/Trace must actually call the LLM (today stubs) + emit `tool_call`/`tool_result`/`preview` events.
- **Shared context environment:** a typed `SharedContext` per session = `SessionState` + `AkisEvent` log + retrieved knowledge (RAG) + a typed scratchpad (NO untyped blob). All agents read it; AKIS dispatches sub-agents with a read view; agents write back only via typed events/returns. RAG `retrieve_knowledge` feeds it.
- New ACs: F2-AC16 (shared context), F2-AC17 (AKIS dispatch w/ context), CORE-AC1 (live agents), CORE-AC2 (default Claude, fail-closed), CORE-AC3 (no committed keys).
- **Verified:** no real key/`.env` ever committed on `feat/real-providers` (only `.env.example`). The other session's gitignore hardening was preventive, not a leak cleanup.

## Status
- Design + roadmap + spec + zero-context review on `claude/akis-agents-rag-system-NDTAH` (PR #3), **rebased onto the agentic core**.
- No implementation yet — M0 (frozen contracts) is next, after the 6 open decisions in `docs/roadmap.md` and once PR #1 + #2 merge.
