> # ⚠️ SUPERSEDED (2026-06-03)
>
> **This 2026-06-01 review is a historical snapshot of an EARLIER codebase and is now STALE.** It reviewed the `feat/real-providers` branch, where several seams were genuinely missing. Most of its "missing / aspirational" findings have since SHIPPED and are tested. Read it for the *original reasoning and the Core-Foundations framing*, not for the current state.
>
> **What changed since this was written (all now in the tree, see `git log` / `README.md`):**
> - **"No SSE / core unreachable over the wire"** → **FALSE now.** Orchestrator HTTP routes + a **resumable** SSE endpoint shipped (`backend/src/api/sessions.routes.ts`, `api/sse.ts`, `events/bus.ts`; per-session `seq` + `Last-Event-ID`; FE `frontend/src/live/EventStreamClient.ts`).
> - **"Scribe/Proto are deterministic stubs that never call an LLM"** → **FALSE now.** Scribe (idea→spec) and Proto (spec→code) call the injected LLM and parse typed artifacts (`backend/src/orchestrator/subagents/ScribeAgent.ts`, `ProtoAgent.ts`); Trace runs a real verifier (Playwright/Cucumber) when `AKIS_REAL_TESTS` is on.
> - **"`tool_call`/`tool_result`/`preview` never emitted"** → **FALSE now.** The sub-agents emit these; a bounded, provider-agnostic tool-loop exists (`agent/tools/toolLoop.ts`) with a real `retrieve_knowledge` tool.
> - **"Roles are a closed union, agents hardcoded, no permission matrix"** → **ADDRESSED.** A gate-tool ownership matrix (`backend/src/workflow/validate.ts`) + an `AgentRegistry` (`agent/dynamic/AgentRegistry.ts`) make producer≠verifier and custom-agent capability data-driven; workflows are versioned config.
> - **"Provider runs the mock silently → fake verified"** → **CLOSED.** `createProvider` fails closed outside `NODE_ENV=test`.
> - **The 4 gates** remain the inviolable spine (still true and still the moat).
>
> **What this review got RIGHT and still holds (do not let the corrections above hide these):**
> - **No real semantic embeddings.** Retrieval is **lexical** — signed feature-hashing (`knowledge/embedding/EmbeddingProvider.ts`) + in-memory BM25, fused with RRF. Call it "lexical + feature-hash retrieval", not "semantic RAG".
> - **No pgvector ANN.** `PgVectorStore` *persists* the corpus but ranks brute-force in JS via an in-memory index; BM25 is in-memory too (rebuilt on boot). ANN + persisted lexical index are still TODO.
> - **No production trust boundary / no sandbox isolation.** `LocalDirectSandbox` is hygiene + blast-radius reduction, not an isolation boundary (see `THREAT-MODEL.md`).
> - **The core build pipeline (Scribe/Proto/Trace) does NOT use the in-turn tool-loop** — that loop + `retrieve_knowledge` are wired into the **advisory/ASK** path only; the core agents get RAG via pre-assembled SharedContext. A core-pipeline tool-loop is a named next step.
>
> **For the current state see `README.md`; for the milestone status see `docs/roadmap.md`; for what's left see `docs/NEXT.md`.**
>
> ---

# AKIS MVP — Architecture Review & Adjustments (2026-06-01)

> Consolidated review of the agentic core (PR #1/#2) + the RAG/Agents plan (PR #3), against the product goals: **flawless operation, Claude-Code-style real-time visibility, dynamic management, high code quality, usable end-to-end.**
> Inputs: a deep code review of `origin/feat/real-providers` (the implementation) + web research on agentic streaming/orchestration best practices (2026).
> **Outcome:** the gate kernel is sound to build on; but several seams our plan assumed **do not exist yet**, and the live-UI/dynamic surfaces are mostly greenfield. This doc records the findings and the concrete plan adjustments (new core prerequisites + new acceptance criteria).

---

## 1. Verdict

**Sound foundation, hollow runtime, missing delivery surface.**
- ✅ **Gate kernel is genuinely well-built.** Four gates on real `unique symbol` brands; capability encapsulation; approval→spec and verify→code **digest binding**; `SessionPatch` type-excludes gate fields; the contract test drives the *real* orchestrator path adversarially (not a vacuous mock). Safe to build on.
- ✅ **Provider seam is clean & dynamic.** `catalog.ts` (single source of model IDs), `createProvider(arg>env>key-prefix, mock fallback)`, encrypted `KeyStore`, `/api/providers`. Adding a model/provider is a localized edit.
- ⚠️ **"Agentic" is aspirational in code.** There is **no agent loop**; Scribe/Proto are **deterministic stubs that never call an LLM** (only Critic does) — so on the "real-providers" branch the actual product output (spec+code) is still fake. `tool_call`/`tool_result`/`preview` events are **never emitted**.
- ⚠️ **No delivery surface.** `api/server.ts` exposes only `/health` + `/api/providers`. There are **no orchestrator routes and no SSE endpoint** — the core is unreachable/unobservable over the wire. The promised `stream.plugin.ts` was never built.
- ⚠️ **Dynamic management is partial.** Provider/model + skills are dynamic; **roles are a closed union with no permission matrix**, agents are hardcoded in DI (no registry), and the orchestrator flow is hardcoded imperative code. Workflow presets + custom agents would currently require **core edits, not config.**

---

## 2. Findings that change OUR plan

The RAG/Agents plan (PR #3) assumed seams that the code review shows are **not yet built**. Honest dependency map:

| Our feature | Assumed seam | Reality (code review) | Consequence |
|---|---|---|---|
| RAG `retrieve_knowledge` **tool** (F1-AC9) | a tool registry + dispatch | **No tool registry exists**; `ToolName` is a doc-only union; no agent loop dispatches tools | RAG-as-a-tool needs the tool seam built first. RAG-as-a-DI-service (agent calls it directly) works today. |
| Model picker **per-agent model** (F2-AC6) | agents accept `{provider,model}` | Only Critic takes a provider; other agents take none | Nothing to bind a per-agent model to until sub-agents are provider-backed. |
| Custom agents + workflow presets (F2-AC1/3) | data-driven roles + agent registry | `Role` is a **closed union**; producer≠verifier is **DI wiring, not a matrix**; flow is imperative | Custom agents/presets need core de-hardcoding first. |
| Live preview (F2-AC7) | SSE stream of `AkisEvent` | **No SSE endpoint**; `tool_call`/`preview` never emitted; events carry counter `ts`, **not a resumable per-session `seq`**; buffer capped at 200, no persistence | A reliable live UI needs the SSE + resumable-stream + tool-event work. |
| Auto-ingest subscriber (F1-AC2) | subscribe to the bus | `EventBus.subscribe` is **per-session only** (no `subscribeAll`) | A global ingestion sink must subscribe as each session starts — small addition. |

**Conclusion:** our M1–M5 now formally depend on a **Core Foundations** layer (owned by the agentic-core lanes A/B, not us). We document it, coordinate it, and do not assume it silently.

---

## 3. Research-grounded requirements (best practices → our ACs)

- **Resumable live stream (Claude-Code-style).** SSE + partial-message streaming is the proven pattern, BUT the client consumption cursor ≠ server emission cursor: without a per-event monotonic id + server buffer + `Last-Event-ID` resume, agent UIs **lose or duplicate messages on refresh/reconnect**. → New AC: resumable `AkisEvent` stream.
- **Reliability = orchestration, not the model.** Most agent outages are hidden state, race conditions, **unbounded loops**, and **over-broad tool scope** → guard with per-step checkpointing, retry+backoff, bounded loops, least-privilege tool scope, and OpenTelemetry observability. → New ACs: bounded agent loop, least-privilege workflow tool scope, observability.
- **Dynamic management** is a 2026 production norm (config-driven orchestration, dynamic agent spawn) — but only viable on a **data-driven role/permission + agent registry**, which we must require of the core.

---

## 4. Plan adjustments (applied to spec/roadmap/MEMORY)

### 4.1 New "Core Foundations" prerequisites (upstream; coordinate with PR #1/#2 owners)
These block our milestones; flagged for the core team (lanes A/B):
- **CF1 — Orchestrator HTTP routes + SSE endpoint** (`POST /sessions`, `/approve|run|confirm`, `GET /sessions/:id/events`). Blocks **M5** (live preview), and usability overall.
- **CF2 — Real sub-agents + agent-loop/tool-dispatch seam + emit `tool_call`/`tool_result`/`preview`.** Blocks **M1** (RAG as a tool), **M5** (live UI shows real steps).
- **CF3 — Per-agent provider/model wiring** (each sub-agent constructed with `createProvider({provider,model})`). Blocks **M3** (model picker binding).
- **CF4 — Data-driven roles + permission matrix + agent registry** (so producer≠verifier is config, not DI wiring; roster is extensible). Blocks **M4** (custom agents / workflow presets).
- **CF5 — Resumable event stream** (per-session monotonic `seq`, server buffer with overflow signal, `Last-Event-ID` resume; consider event-log persistence). Blocks **M5** reliability.
- **CF6 — Core hardening:** close the `confirmPush` double-push window (atomic status re-check/lock around the GitHub side effect); wrap `recordVerification` behind a capability (not a public store method); make `createProvider` **fail closed** on misconfig outside tests (today it silently runs the mock → fake "done/verified"). These directly serve "flawless operation."

> If a core seam is not ready when a milestone starts, the fallback is: ship RAG as a **DI service** (agent calls it directly) instead of an LLM-callable tool, and the model picker as **read-only** until CF3 lands.

### 4.2 New acceptance criteria (added to the spec)
- **F1-AC17 (ingestion subscription):** a global ingestion sink subscribes per session as sessions start (works around per-session-only `subscribe`); no event is missed between session start and subscription.
- **F2-AC12 (resumable live stream):** the live preview survives refresh/reconnect with no lost or duplicated steps — backed by per-session monotonic `seq` + `Last-Event-ID` (CF5).
- **F2-AC13 (bounded agent loop):** every agentic run has a hard step/iterate cap (the existing `MAX_ITERATE` generalized) and a wall-clock budget; exceeding it ends the run as `failed` with a typed reason, never an unbounded loop.
- **F2-AC14 (least-privilege tool scope):** a `WorkflowConfig` grants each agent the **minimum** tool set; tools not in the workflow are not dispatchable for that run (over-broad scope is the #1 orchestration outage cause).
- **F2-AC15 (observability):** core + RAG emit OpenTelemetry-style spans/metrics (run/step latency, tokens, gate events, ingest/retrieval health) queryable without code changes.
- **X-AC6 (fail-closed providers):** outside `NODE_ENV=test`, a misconfigured provider/key fails loudly; the mock never silently produces "verified" output in prod (CF6).

### 4.3 Dependency reframe
`docs/roadmap.md` **D1** now = "PR #1 + #2 merged **and** the relevant Core Foundations (CF1–CF6) landed for the milestone in question." Each milestone lists its CF prerequisite.

---

## 5. What stays unchanged (validated by the review)
- RAG: server-side pgvector, hybrid+rerank, golden-eval gate, tenancy filter, dead-letter, secret exclusion — all still correct; the DI `KnowledgePort` seam is clean (additive to `di/services.ts`).
- Workflow = bounded preset validated vs roles matrix + gate invariants + catalog — correct, and now explicitly depends on CF4 making roles data-driven.
- Model picker on `/api/providers` — the provider seam is ready; only the per-agent binding (CF3) is missing.
- The 4 gates as the inviolable invariant — confirmed real (modulo the documented same-realm gap CF6 addresses).

---

## 6. Sources (research)
- Claude Code streaming / dynamic workflows / agent view (Anthropic docs + 2026 analyses).
- Resumable SSE: Last-Event-ID, server buffer, consumption-vs-emission cursor pitfall.
- 2026 agent orchestration reliability: checkpointing, bounded loops, least-privilege tool scope, OpenTelemetry; "outages are orchestration, not the model."

Links:
- https://code.claude.com/docs/en/agent-sdk/streaming-output
- https://www.cloudzero.com/blog/claude-code-agents/
- https://zknill.io/posts/everyone-said-sse-token-streaming-was-easy/
- https://starcite.ai/blog/why-agent-uis-lose-messages-on-refresh
- https://www.knowlee.ai/blog/ai-agent-orchestration-guide-2026
- https://www.digitalapplied.com/blog/agentic-workflow-anti-patterns-orchestration-mistakes-2026

_Authored 2026-06-01 from a deep code review of the implementation + best-practice research. The gate kernel is the moat; the live-UI, dynamic-management, and tool-runtime surfaces are the real build-out ahead._
