# Design — Sub-project #1: Agentic Orchestrator + 4 Structural Gates (on mock)

> **Status:** design, awaiting user review.
> **Date:** 2026-06-01.
> **Scope:** the FIRST vertical slice of `akis-platform-mvp`. Builds the **agentic orchestration core** (provider-agnostic) with **4 structural verification gates**, end-to-end on the **mock** provider, locked by a backend **contract test** written first (TDD).
> **Inputs:** `../../../HANDOFF.md`, `../../../docs/v1-architecture-audit.md`, the 2026-06-01 read-only survey of AKIS v1 (`/Users/omeryasironal/Projects/akis-platform`), and the akis-v2 producer≠verifier work (permission-layer enforcement).

---

## 0. ⚠️ Deliberate pivot from the handoff

`HANDOFF.md` (2026-05-31) **locked** "keep the FSM / verification chain; do NOT go full-agentic." This spec **consciously reverses that**, by the product owner's decision this session:

- **Flow is agentic.** A conversational **main orchestrator agent** decides which sub-agents/skills to dispatch, in what order, and can parallelize — there is **no rigid FSM transition table** dictating the sequence.
- **But 4 invariants stay STRUCTURAL** (the "hybrid: gates at critical moments" choice). These are not the agent's choice; they are enforced at the type/permission layer.

Why it's safe: the **2026-06-12 defense runs on v1** (which has the FSM chain), so the thesis demo is untouched. This MVP is parallel/post-defense, so the agentic pivot carries no defense risk. The thesis claim ("quality trust") is preserved here by the 4 structural gates, not by a fixed sequence.

## 1. The 4 structural gates (NON-NEGOTIABLE — the whole point)

Everything else is free agentic flow. These four are enforced by construction, asserted by the contract test (§8):

1. **Spec-approval gate (human).** The orchestrator **cannot** dispatch Proto to write code until a human approves the Scribe spec. Enforced: the `dispatch_proto` tool is unavailable / denied until an `approvedSpec` exists in session state.
2. **Producer ≠ verifier (role-based tool permission).** The agent/role that writes code (Proto / orchestrator) **cannot** run tests. The `run_tests` tool is callable **only** by the `verifier` (Trace) role. Enforced at the tool-permission layer (akis-v2's `canUseTool` lesson), not advisory `allowedTools`.
3. **"Verified" = a real test run.** The `verified` flag latches **only** when a real Trace test run reported **≥1 test that executed and passed**. Zero/empty/no-op runs → `⚠️ unverified`, never `✅`. Enforced by a reducer over the event stream, not by any agent's assertion.
4. **Push gate (token + verified + human).** GitHub push/PR requires an `ApprovedPush` **branded token** that is mintable **only** by the human push-confirm action **and only when `verified === true`**. `pushToGitHub(token: ApprovedPush)` won't type-check without it. Compile-time, not per-path discipline.

A breach of any gate is a build/test failure.

## 2. Context & why mock-first is cheap

AKIS v1 is a working Fastify+React thesis platform; its value is a human-in-the-loop verification chain. v1 does **not** use the Claude Agent SDK — it has its own orchestrator — so building **our own provider-agnostic agent loop** is consistent with the codebase, not a fight against it.

**Survey insight:** v1's agents already sit behind a narrow `generateText(systemPrompt, userPrompt)` adapter (`pipeline-factory.ts:204-215`) wrapping `aiService.generateWorkArtifact()`; `MockAIService` returns deterministic responses by keyword-matching the systemPrompt. We extend this so the **mock can also drive the agentic loop deterministically** (scripted tool-call sequences via knobs). The full agentic flow + all 4 gates run on mock with **zero API keys**.

This MVP is the first step of the larger studio vision (provider-agnostic, live preview, analytics, AI-futuristic UI, own skills, parallel-agent live streaming). #1 builds the **agentic core + gates**; later sub-projects add the surfaces that consume it.

## 3. Locked decisions (this session)

| Topic | Decision |
|---|---|
| Flow model | **Agentic** — main orchestrator agent decides flow; **no rigid FSM**. |
| Gates | **4 structural gates** (§1): spec-approval, producer≠verifier, verified=real-test, push. Everything else free. |
| Scope relation | Full studio vision is the long-term target; **#1 is the backend agentic core + gates only**. v1 untouched (defense demo). MVP parallel/post-defense. |
| Stack | Keep v1's: Fastify 4 + TS strict + Drizzle + Postgres 16 (pgvector) + React 19 + Vite 7 + Tailwind v4. |
| Reuse | Port v1 IP (agent prompts + logic + Validator + Critic + AIService/mock); **write new** the agent loop, tool/permission layer, gates, event stream. |
| Repo layout | `backend/ + frontend/ + shared/`, root pnpm workspace; `shared/` holds frozen contracts. |
| Provider-agnostic | Own agent loop over a narrow `LlmProvider` (text + **tool-calling** + streaming); **mock only** in #1; real adapters later. |
| Roles | `orchestrator`, `scribe`, `proto`, `trace`(=verifier), `critic` in #1; roster extensible (Research/Critic later) by config + prompt. |
| Live streaming | `AkisEvent` stream with per-agent + per-lane tagging from day one (parallel lanes visible). |
| Mock control | Declarative knobs (`{mockNeedsClarification, mockCriticScore, mockTraceTestCount, mockProtoFixesOnIterate, scriptedToolCalls}`) for deterministic scenarios. |
| Contract test origin | Executable spec of the new agentic core (TDD red→green), NOT run against v1. |

## 4. Scope of sub-project #1

**In scope:** the provider-agnostic **agent loop**; the **main orchestrator agent** (conversational, holds session state, dispatches sub-agents, narrates, can run sub-agents in parallel); **sub-agents** Scribe/Proto/Trace/Critic (ported prompts); the **tool registry + role-based permission layer**; the **4 structural gates**; the **AkisEvent live stream** (per-agent/lane); a **skills/dynamic-prompt registry** (minimal: prompts are data, hot-swappable — wiring only, full editor UI later); the narrow `LlmProvider` + mock; the day-1 contract test + a CLI smoke; the `backend/ + frontend/ + shared/` scaffold.

**Out of scope (deferred; designed not to require a rewrite):** real providers + selection UI + key management; the FE chat shell, top-right live preview, analytics page, AI-futuristic UI polish; the skills **editor UI** (registry seam exists now); DevAgent; CI polling; RAG/knowledge injection; multi-project git/PR lifecycle (mock GitHub adapter in #1).

## 5. Repo structure

```
akis-platform-mvp/
  package.json · pnpm-workspace.yaml          # workspace: backend, frontend, shared
  shared/src/                                  # FROZEN cross-session contracts (no runtime deps)
    events.ts            # AkisEvent union (session/text/agent_start/agent_end/tool_call/tool_result/gate/verify/preview/done/error) + agent + laneId
    roles.ts             # Role union; tool→role permission matrix type
    session.ts           # typed SessionState (spec, approvedSpec, verified, artifacts, gate states)
  backend/src/
    agent/
      LlmProvider.ts      # interface: generateText + tool-calling + streaming
      AgentLoop.ts        # generic provider-agnostic think→tool→observe loop
      mock/               # MockProvider (scripted tool-calls + knobs)
    orchestrator/
      Orchestrator.ts     # main conversational agent: system prompt + toolset + state; narrates
      subagents/          # ScribeAgent, ProtoAgent, TraceAgent, CriticAgent (ported prompts/logic)
      parallel.ts         # fan-out + join for concurrent sub-agent dispatch
    tools/
      registry.ts         # tool definitions (dispatch_*, run_tests, request_spec_approval, request_push, push_to_github)
      permission.ts       # role-based canUseTool (run_tests → verifier only); the producer≠verifier gate
    gates/
      specApprovalGate.ts # dispatch_proto-write blocked until approvedSpec exists
      verifiedReducer.ts  # verified latches only on a real ≥1-test pass event
      pushGate.ts         # branded ApprovedPush (mint requires verified===true + human confirm)
    validator/            # DeterministicValidator + checks (ported verbatim)
    events/
      bus.ts              # AkisEvent emitter + ring buffer (ported pipelineBus shape)
      stream.plugin.ts    # SSE endpoint (ported)
    skills/
      registry.ts         # skill = named versioned prompt/instruction bundle; injected per role
    store/                # SessionStore interface; MockSessionStore (tests); DrizzleSessionStore (runtime)
    di/services.ts        # OrchestratorServices DI container
  backend/test/contract/agentic-gates.contract.test.ts
  backend/test/unit/...
  backend/scripts/smoke-mock-run.ts
  frontend/               # React 19 + Vite 7 + Tailwind v4 (scaffold only in #1)
```

`shared/` is the only surface parallel sessions import; frozen first.

## 6. Architecture

### 6.1 `agent/LlmProvider.ts` — provider-agnostic, tool-calling
```ts
interface LlmProvider {
  name: string;
  chat(req: ChatRequest): Promise<ChatResult>;        // returns text and/or tool calls
  stream?(req: ChatRequest): AsyncIterable<ChatDelta>; // for live streaming
}
// ChatRequest carries: messages, system prompt, available tools (name+schema), role.
// ChatResult: { text?, toolCalls?: {name, args}[], usage }.
```
The orchestrator and every sub-agent are LLM agents over this one interface. Swapping providers changes only the adapter. #1 ships `MockProvider` (scripted, knob-driven); real adapters (Anthropic/OpenAI/Gemini/OpenRouter) implement the same interface later — this is the "every LLM" requirement.

### 6.2 `agent/AgentLoop.ts` — the generic loop
`runAgentLoop({ provider, systemPrompt, tools, role, onEvent })`: the think→tool→observe loop. Calls `provider.chat`, executes returned tool calls **through the permission layer** (§6.4), feeds results back, emits an `AkisEvent` per step, until the agent emits a terminal tool/`done`. Pure and provider-agnostic; used by the orchestrator and (optionally) by sub-agents. Streaming via `provider.stream` feeds `text` deltas to the event bus.

### 6.3 `orchestrator/Orchestrator.ts` — the main conversational agent
- A `runAgentLoop` instance with `role: 'orchestrator'`, a system prompt (the "how to drive AKIS" brief), and a toolset: `dispatch_scribe`, `dispatch_proto`, `dispatch_trace`, `dispatch_critic` (sub-agent dispatch; can be issued in parallel → `parallel.ts`), `request_spec_approval`, `request_push_confirm`, plus free `ask`/`chat`. It holds/threads `SessionState`, narrates via `text` events, and stays in command. It does **not** get `run_tests` or `push_to_github` (those belong to the verifier role / the push gate).
- **Sub-agents** are dispatched via tools; each runs its own loop (or single call) with its role + ported prompt, returns a structured result the orchestrator observes. Parallel dispatch streams on separate `laneId`s.

### 6.4 `tools/permission.ts` — producer≠verifier (Gate 2)
A `canUseTool(role, toolName, ctx)` checked **before every** tool execution in `AgentLoop`. The matrix: `run_tests` → `verifier` only; `push_to_github` → requires an `ApprovedPush` arg (Gate 4); `dispatch_proto` (code-write mode) → denied unless `ctx.approvedSpec` (Gate 1). A denied call returns a typed `PermissionDenied` to the agent (it must adapt), and emits a `gate` event. This is the structural producer≠verifier enforcement, mirroring akis-v2.

### 6.5 `gates/specApprovalGate.ts` — Gate 1
`request_spec_approval` emits a `gate` event and parks the session at `awaiting_spec_approval`; the human `approve(spec)` writes `approvedSpec` to state. Until then `dispatch_proto` (write) is denied by §6.4. (Reject loops back to Scribe.)

### 6.6 `gates/verifiedReducer.ts` — Gate 3
A pure reducer over the event stream: `verified` becomes `true` **iff** a `verify` event from the `verifier` role reports `testsRun ≥ 1 && passed === true`. No agent can set it directly. `mockTraceTestCount=0` → stays `false`.

### 6.7 `gates/pushGate.ts` — Gate 4
```ts
type ApprovedPush = { readonly __brand: 'ApprovedPush'; sessionId: string };
function mintApprovedPush(s: SessionState): ApprovedPush  // throws unless s.verified === true, after human confirm
function pushToGitHub(token: ApprovedPush, ...): Promise<PushResult>  // requires the token
```
`request_push_confirm` parks at `awaiting_push_confirm`; the human `confirmPush()` calls `mintApprovedPush` (throws if not verified) and only then is `push_to_github` callable. Nothing else constructs the token → push without verified+confirm doesn't type-check. #1 writes via `MockGitHubAdapter`.

### 6.8 `events/bus.ts` + `shared/events.ts` — live streaming
`AkisEvent` union, every event tagged with `agent` (orchestrator/scribe/proto/trace/critic) and a `laneId` (for parallel branches). Kinds: `session`, `text` (narration), `agent_start`/`agent_end`, `tool_call`/`tool_result`, `gate` (the trust moments), `verify` (verifier-only), `preview`, `done` (+ `verified`, provider/model, usage), `error`. The FE renders a live, possibly-parallel step tree (later sub-project); #1 ships the stream + a recording sink for tests + the SSE plugin.

### 6.9 Ported IP
- **Verbatim:** CriticAgent + types + `prompts/spec-review.ts` + `prompts/code-review.ts`; DeterministicValidator + checks + ValidatorTypes; MockAIService dispatch core; `pipelineBus`/ring-buffer + SSE plugin shape.
- **Adapt:** Scribe prompts (CLARIFICATION + SPEC_GENERATION) + clarify/generate state machine → `ScribeAgent` sub-agent; Proto `SCAFFOLD_SYSTEM_PROMPT` + iteration prompt → `ProtoAgent` (text-only, MockGitHub); Trace test-gen prompt + AC-coverage → `TraceAgent` (the verifier; dryRun on in-memory files); `generateText` adapter → `LlmProvider.chat`.
- **Survey facts to honor:** `ValidationInput={files:{filePath,content}[],spec?}`, `passed = score>=60 && errors===0`; `CriticReviewInput.reviewType:'spec'|'code'`, `CriticReviewOutput{approved,overallScore,findings,summary,hasCriticalFinding,maxSeverity}`, default `approvalThreshold=75`.

## 7. Data flow — one full mock run (happy path)

1. `orchestrator.start(idea)` → loop runs → `dispatch_scribe` → ScribeAgent (mock: spec) → orchestrator narrates → `dispatch_critic(spec)` (mock: approved) → `request_spec_approval` → **parks** (Gate 1).
2. Human `approve(spec)` → `approvedSpec` set → orchestrator resumes → `dispatch_proto` (now permitted) → ProtoAgent (mock: files via MockGitHub).
3. Orchestrator → `dispatch_critic(code)` (mock: approved) + `DeterministicValidator` (pass) → `dispatch_trace` (**verifier role**; only it can `run_tests`; mock: ≥1 test, pass) → `verify` event → reducer sets `verified=true` (Gate 3).
4. Orchestrator → `request_push_confirm` → **parks** (Gate 4).
5. Human `confirmPush()` → `mintApprovedPush` (ok, verified) → `push_to_github(token)` (MockGitHub) → `done` event, `verified=true`.

**Free-agentic branches the orchestrator may choose** (not dictated by a table): run Scribe-spec-critic in parallel; re-dispatch Proto with Critic/Trace feedback to fix (iterate — agent decides, no fixed loop); answer ASK/CHAT without building. **What it can NEVER do:** write code before spec approval, run tests as producer, mark verified without a real test, or push without verified+confirm.

## 8. The day-1 contract test (TDD lock)

`backend/test/contract/agentic-gates.contract.test.ts` — vitest, `MockProvider` with scripted tool-calls + knobs, MockGitHubAdapter, recording event sink. No network/keys. Written first (red), drives the build to green. Asserts the **4 gates structurally**, regardless of agent flow:

- **A — happy path:** a full run reaches `done` with `verified=true`; the `gate` events for spec-approval and push-confirm both fired and were satisfied by human actions; `ApprovedPush` was minted only after `confirmPush`.
- **B — Gate 1 (spec approval):** force the orchestrator (scripted) to attempt `dispatch_proto` before approval → `PermissionDenied`; no Proto code artifact is produced before `approve`.
- **C — Gate 2 (producer≠verifier):** force `proto`/`orchestrator` role to call `run_tests` → `PermissionDenied`; only the `verifier` role's `run_tests` succeeds.
- **D — Gate 3 (verified=real test):** `mockTraceTestCount=0` → `verified` stays `false`; push-confirm cannot mint a token (`mintApprovedPush` throws); never reaches `done`/`✅`.
- **E — Gate 4 (push):** assert `push_to_github` is uncallable without an `ApprovedPush` (type-level + runtime guard); minting requires `verified===true`.
- **F — liveness/streaming:** every tool call emitted a `tool_call`+`tool_result` event tagged with `agent`+`laneId`; a parallel dispatch produced ≥2 concurrent lanes; the `verify` event is `verifier`-tagged.

This is the regression tripwire: any later change that lets a gate be bypassed goes red.

## 9. Error handling
- Tool/sub-agent errors → typed result the agent observes (it may retry/adapt) + an `error`/`gate` event; unrecoverable → session `failed` with a typed error.
- `PermissionDenied` is a first-class observable result (the agent must route around it), never a silent no-op.
- `mintApprovedPush` throws `NotVerifiedError` if `verified!==true` — caught and surfaced, never swallowed.
- All session mutations under a per-session lock; the reducer is the only writer of `verified`.

## 10. Testing strategy
- **Framework:** vitest; `MockProvider`, no network.
- **Unit:** AgentLoop (tool dispatch + permission check + event per step), permission matrix (every role×tool), verifiedReducer (latches only on real test), pushGate (token only via verified+confirm), specApprovalGate (proto-write blocked), DeterministicValidator (ported), each sub-agent wrapper, mock knobs/scripting.
- **Contract:** §8 (the 4-gate lock).
- **Smoke:** `scripts/smoke-mock-run.ts` drives one full agentic run and prints the live event timeline (incl. a parallel lane) ending `done`/`verified=true`, plus the vacuous-green run ending `⚠️`.
- **Store:** `MockSessionStore` for unit/contract; one integration test exercises `DrizzleSessionStore`.

## 11. Build order (8 steps, mergeable)
1. **Scaffold + contract test (red):** pnpm workspace, vitest, frozen `shared/` contracts (events/roles/session), and the §8 contract test against the not-yet-built orchestrator (TDD red).
2. **Provider + loop:** `LlmProvider` interface; `MockProvider` (scripted tool-calls + knobs); `AgentLoop` (think→tool→observe + event emission).
3. **Tools + permission (Gates 1&2):** tool registry; `canUseTool` matrix (run_tests→verifier; dispatch_proto needs approvedSpec); `PermissionDenied` flow.
4. **Port pure IP:** CriticAgent + 2 prompts; DeterministicValidator + checks; MockAIService dispatch core; event bus + SSE plugin.
5. **Sub-agents:** ScribeAgent, ProtoAgent (text-only + MockGitHub), TraceAgent (verifier, dryRun), CriticAgent wrapper — each a role over AgentLoop with ported prompts.
6. **Gates 3&4:** `verifiedReducer`; `pushGate` (branded `ApprovedPush`, `mintApprovedPush` requires verified); wire `request_spec_approval` / `request_push_confirm` parking + human `approve`/`confirmPush`.
7. **Orchestrator + parallel:** main agent system prompt + toolset + session state + narration; `parallel.ts` fan-out/join with per-lane events; minimal skills/dynamic-prompt registry seam.
8. **Green + smoke:** make the contract test pass (Scenarios A–F); `scripts/smoke-mock-run.ts` prints a correct live timeline incl. a parallel lane.

## 12. Risks
- **Agentic non-determinism vs a deterministic contract test:** mitigated by the `MockProvider` scripted tool-call surface — the test pins the agent's choices; the gates are asserted regardless of flow. Real-provider runs will vary (expected); the gates still hold.
- **Permission layer is the new load-bearing seam** (replaces the FSM as the thing that "must not break"). Mitigate with exhaustive role×tool unit tests + the contract lock.
- **Stack-agnostic Proto prompt:** v1's scaffold prompt is React/Vite/Sandpack-specific; cosmetic for mock #1, flagged for real-AI.
- **Scope creep:** the studio vision is large; #1 is the agentic core + gates only. Resist pulling FE/preview/analytics/skills-UI forward until the core + gates are locked.
- **Thesis framing shift:** the claim moves from "deterministic pipeline" to "agentic orchestration with structural verification gates." Defense (v1) is unaffected; document the framing for any future MVP-based defense.

## 13. Definition of done (sub-project #1)
- `pnpm -C backend test` green: contract test (Scenarios A–F) + unit tests.
- `tsc` strict clean across `shared/` + `backend/`.
- `scripts/smoke-mock-run.ts` prints a correct live agentic timeline: `done`/`verified=true` (happy, incl. a parallel lane) and `⚠️` (vacuous-green).
- Structurally impossible (asserted): write code before spec approval · run tests as producer · mark verified without a real test · push without `ApprovedPush` (which requires verified + human confirm).
- All on branch `feat/agentic-core-gates`; backend work in one or more reviewable PRs; BE/FE always separate PRs.
