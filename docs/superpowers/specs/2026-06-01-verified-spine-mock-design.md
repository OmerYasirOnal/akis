# Design — Sub-project #1: Provider-agnostic Verified Pipeline Spine (on mock)

> **Status:** design, awaiting user review.
> **Date:** 2026-06-01.
> **Scope:** the FIRST vertical slice of `akis-platform-mvp`. Builds the human-in-the-loop verification chain end-to-end on the **mock** provider, locked by a backend **contract test** written first (TDD).
> **Inputs:** `../../../HANDOFF.md`, `../../../docs/v1-architecture-audit.md`, and the 2026-06-01 read-only survey of AKIS v1 (`/Users/omeryasironal/Projects/akis-platform`) — all 27 cited v1 files verified present.

---

## 1. Context

AKIS v1 is a working Fastify+React thesis platform whose value is one linear, human-in-the-loop **verification chain**:

```
Scribe (idea→spec) → Critic (spec-review) → HUMAN APPROVAL GATE
  → Proto (spec→code) → DeterministicValidator → Critic (code-review)
  → Trace (code→tests, auto-run) → PUSH-CONFIRM GATE → GitHub
```

v1 works, but its three pains (crowded chat, crowded orchestrator, "fix one bug → spawn another" + parallel-session collisions) share **one root cause**: low-altitude monolith files with no vertical seams (2877-line orchestrator, 1359-line `ChatMessage`) plus shared mutable surfaces (untyped `intermediateState` bag; 57-prop bag; a 15-value `uiState` re-listed across 4 files).

This MVP is a **clean rebuild** (parallel to v1; v1 stays the untouched 2026-06-12 defense demo). The long-term target is a full provider-agnostic studio (live preview, analytics, AI-futuristic UI, own skills, parallel-agent live streaming). We build it as a sequence of sub-projects, **starting from the spine**, because every later surface is a consumer of it.

**Key survey insight that makes mock-first cheap:** v1's agents are already decoupled from the provider via a narrow `generateText(systemPrompt, userPrompt)` adapter (`pipeline-factory.ts:204-215`) wrapping `aiService.generateWorkArtifact()`. `MockAIService` dispatches deterministic responses by keyword-matching the systemPrompt. So the full chain runs on mock with **zero API keys**.

## 2. The thesis invariants (NON-NEGOTIABLE — designed in from day one)

1. **"Verified" = a real test run, code-enforced.** A run renders `verified` only after Trace produced **≥1 real test**. Zero/empty/no-op test runs render `⚠️ unverified`, never `✅`.
2. **Producer ≠ verifier path.** Proto produces code; the Validator→Critic→Trace gate evaluates it. Distinct stages, distinct outputs, fixed order.
3. **Push is unreachable until approved — structurally.** GitHub push requires an `ApprovedPush` **branded/opaque token** that only the push-confirm transition can mint. Code that pushes without it does not compile.
4. **One verification-chain runner.** Exactly one `postProtoQualityGates(ctx, input, dryRun)`; never re-implemented per path. (v1 had it in 5 places; one bypassed all gates.)
5. **Forgotten-emit is impossible.** Every stage change goes through `transition()`, which performs the store update **and** emits the SSE activity. No stage changes silently.

A breach of any invariant is a build/test failure, asserted by the contract test (§8).

## 3. Locked decisions (this session)

| Topic | Decision |
|---|---|
| Scope relation | Full studio vision is the long-term target; **#1 is backend-spine-only**. v1 untouched (defense demo). MVP is parallel/post-defense. |
| Stack | Keep v1's: Fastify 4 + TS strict + Drizzle + Postgres 16 (pgvector) + React 19 + Vite 7 + Tailwind v4. |
| Reuse | Port v1 IP (agents + prompts + Validator + AIService/mock + Critic); **rewrite** orchestration + chat shell on new seams. |
| Repo layout | `backend/ + frontend/ + shared/`, root pnpm workspace. `shared/` holds frozen contracts. |
| Orchestration approach | **Full abstraction now:** EVERY stage *and* lifecycle action goes through the uniform `Stage`/`StageOutcome` interface from day one (no stage emits inline). Purest seams; highest up-front investment, but it is the foundation the whole studio vision consumes. Keystones written new; pure IP + v1's outcome-unions ported verbatim. |
| Critic placement | **Both passes** — spec-review (after Scribe, before approval gate) + code-review (after Proto). |
| Iterate loops | **Included in #1.** Both auto-iterate retry loops — critic-iterate and trace-iterate (max 3, env-driven, single shared budget) — plus critic **hard-block** (→`awaiting_critic_resolution`, push unreachable). `fix_loop_iteration` is a live stage in the table. |
| Push-confirm gate | **Always on** (dryRun Trace → manual confirm). No `AUTO_PUSH` short-circuit. |
| SSE atomicity | **Emit after the DB txn commits** (DB is source of truth; SSE can never lead the store). |
| Mock control surface | Add explicit knobs (`{mockCriticScore, mockValidatorPass, mockScribeNeedsClarification, mockTraceTestCount}`) instead of fragile keyword inference, for deterministic negative scenarios. |
| Provider-agnostic | Narrow `LlmProvider` + **mock only** in #1; real adapters (Anthropic/OpenAI/Gemini/OpenRouter) later. |
| modelAllowlist | Out of scope for #1 (env provider resolution is enough). |
| Contract test origin | Written as the **executable spec of the new spine** (TDD red→green), NOT run against v1. v1 read only to confirm the true ordering. |

## 4. Scope of sub-project #1

**In scope:** the backend spine (FSM + typed state + uniform Stage plugins for **every** stage and lifecycle action + the single quality-gate runner + the push gate); ported IP (Scribe/Proto/Trace/Critic + prompts, DeterministicValidator, mock provider); the narrow `LlmProvider` with mock only; the human gates' backend lifecycle (approve / reject / confirmPush / cancelPush / cancel — each a lifecycle outcome, not inline mutation); **both auto-iterate loops** (critic-iterate + trace-iterate, max 3, single shared budget); the day-1 contract test + a CLI smoke; the `backend/ + frontend/ + shared/` scaffold with frozen contracts.

**Out of scope (deferred; designed not to require a rewrite):** real providers + selection UI + key management; the FE chat shell, live step streaming, top-right live preview, analytics page, AI-futuristic UI; the skills system (Scribe keeps its `SkillRegistry` injection seam); DevAgent; CI polling (`ci_running`); RAG/knowledge injection; the agentic tool-use Proto path (text-only first).

## 5. Repo structure

```
akis-platform-mvp/
  package.json · pnpm-workspace.yaml      # workspace: backend, frontend, shared
  shared/src/pipeline/                     # FROZEN cross-session contracts (no runtime deps)
    stages.ts            # PipelineStage union + isTerminalStage
    events.ts            # PipelineActivity SSE shape (ported verbatim from v1)
    intermediateState.ts # typed IntermediateState interface
  backend/src/pipeline/
    fsm/                 # transitionTable.ts, transition.ts
    core/                # IntermediateState merge, Stage.ts, StageOutcome.ts, PipelineTypes (adapted)
    stages/             # ScribeStage, ProtoStage, TraceStage, postProtoQualityGates.ts, pushGate.ts
    agents/             # scribe/ proto/ trace/ critic/ (ported IP + prompts)
    validator/          # DeterministicValidator + checks (ported verbatim)
    provider/           # LlmProvider.ts + mock/ (MockAIService + scenarios/knobs)
    di/                 # OrchestratorServices.ts; adapters/ (aiDeps, MockGitHubAdapter)
    store/              # PipelineStore interface; MockPipelineStore (tests); DrizzlePipelineStore (runtime)
    coordinator/        # PipelineCoordinator.ts (thin)
    activity/           # activityEmitter (pipelineBus + ring buffer), folded into transition()
  backend/test/contract/pipeline-verified-spine.contract.test.ts
  backend/test/unit/...
  backend/scripts/smoke-mock-run.ts
  frontend/             # React 19 + Vite 7 + Tailwind v4 (scaffold only in #1)
```

`shared/` is the only surface multiple parallel sessions import; frozen first so backend lanes never collide.

## 6. Architecture

### 6.1 PipelineStage (frozen in `shared/`) — v1 names verbatim
In scope for #1:
`scribe_clarifying | scribe_generating | critic_reviewing_spec | awaiting_approval | proto_building | critic_reviewing_code | awaiting_critic_resolution | fix_loop_iteration | trace_testing | awaiting_push_confirm | completed | failed | cancelled`.
Carried in the union but unused in #1's table: `ci_running`, `completed_partial`. The table is **derived from v1's `assertStage` allowlists** — encode existing legal behavior, don't redesign.

### 6.2 `fsm/transitionTable.ts` + `fsm/transition.ts`
- `TRANSITION_TABLE: Record<PipelineStage, readonly PipelineStage[]>` — the single source of legal edges (e.g. `awaiting_approval → [proto_building, cancelled]`; `critic_reviewing_code → [trace_testing, awaiting_critic_resolution, proto_building]`).
- `transition(pipelineId, toStage, ctx)`: read fresh state under optimistic lock (`expectedStageVersion`) → assert `to ∈ TRANSITION_TABLE[from]` (else typed `IllegalTransitionError`) → commit `store.update({stage, ...merge})` in a DB txn → **after commit**, emit the `PipelineActivity` via the injected emitter. Returns `{newState, emitted[]}` for testability. Single choke-point for stage truth; forgotten-emit impossible; SSE never leads the store.
- `TransitionCtx` (store, emit, lock, services) is a **frozen contract** for parallel sessions.

### 6.3 `shared/intermediateState.ts` + `core/mergeIntermediateState`
- Replace v1's `Record<string,unknown>` with a typed interface over the 19 inventoried keys (`validationResult`, `criticSpecOutput`, `criticCodeOutput`, `criticBlock`, `criticIterateRetryCount`, `traceIterateRetryCount/LastFeedback/LastAt`, `acCoverage`, `autoApproveEnabled/Threshold`, `imageBlocks`, `parentPipelineId`, `iterationRequest`, `existingRepo`, …). Iterate/CI keys typed-but-optional for forward-compat.
- `mergeIntermediateState(existing, patch): IntermediateState` — the ONE typed merge (no unknown-key spread, no silent overwrite). A typo is a compile error; last-writer-wins races fixed centrally.

### 6.4 `core/Stage.ts` + `core/StageOutcome.ts` — uniform plugin (FULL abstraction)
```ts
interface Stage<I> { name: PipelineStage; run(ctx: StageContext, input: I): Promise<StageOutcome>; }
```
- **Every** stage *and* every lifecycle action (approve/reject/confirmPush/cancelPush/cancel) is a unit returning a `StageOutcome`. Nothing emits inline — the exhaustive handler is the single side-effect site. This closes the v1 gap where Scribe + lifecycle methods hand-sequenced `store.update + emit` (the forgotten-emit bug class) while only Proto/Trace used outcome unions.
- `StageContext` carries `OrchestratorServices` + `pipelineId` + current `IntermediateState` + a transition-bound `emit`.
- `StageOutcome` is a discriminated union (`success{nextStage, intermediateUpdates, output}` | `iterate{toStage, feedback, retryBudget}` | `error{error, recovery?}` | `await_gate{gate:'approval'|'critic_resolution'|'push_confirm'}`) with an exhaustive `default: const _: never` handler. Per-stage/lifecycle unions: `ScribeOutcome` (new), `LifecycleOutcome` (new, for the gate actions), and v1's `ProtoTraceOutcome`/`TraceOutcome` **reused verbatim**.

### 6.5 `stages/postProtoQualityGates.ts` — THE single runner
`postProtoQualityGates(ctx, input, dryRun)` runs, in canonical order, **DeterministicValidator.validate → CriticAgent.reviewCode → iterate-eval**, returning a `ProtoTraceOutcome` (`validation_failed | critic_iterate | critic_hard_block | ready_for_trace`). Trace runs in the FSM caller after `ready_for_trace`. Extracted from v1's `runProtoAndTrace.ts` determination logic (`L345-445` Validator → `L449-607` Critic → `L609-621` ready). Every change-path uses this one runner.

### 6.5a `helpers/iterateLoop.ts` — unified auto-iterate
v1 has twin, ~95%-identical loops (`evaluateCriticIterateLoop` / `evaluateTraceIterateLoop` + twin dispatchers). #1 unifies them into ONE `IterateLoop` parameterized by `{counterKey, envCap, buildFeedback, shouldIterate}` reading the typed `IntermediateState` counters (`criticIterateRetryCount` / `traceIterateRetryCount`, env caps default 3) with a **single shared retry budget** (v1's correctness smell: two independent budgets feeding the same `proto_building` re-entry). On `shouldIterate`, the runner returns an `iterate{ toStage: 'fix_loop_iteration' → 'proto_building', feedback }` outcome; the dispatcher keeps v1's cancel-race guard (re-read fresh state, bail if terminal) but routes through `transition()`. On budget exhaustion → `critic_hard_block` (→`awaiting_critic_resolution`) or a Trace `failed` outcome — never a silent push, never a false `✅`.

### 6.6 `stages/pushGate.ts` — branded approval token
```ts
type ApprovedPush = { readonly __brand: 'ApprovedPush'; pipelineId: string };
// only confirmPush() mints ApprovedPush; pushToGitHub(token: ApprovedPush, ...) requires it.
```
`pushToGitHub` (and any GitHub write) takes `ApprovedPush`; nothing else constructs it → push without approval doesn't type-check. In #1 the write is the `MockGitHubAdapter`; the token machinery is real and tested.

### 6.7 `di/OrchestratorServices.ts` — DI container
One object built once at startup: `{ aiService, store, emit, validator, criticAgent, scribe/proto/trace stage instances, mockGitHub adapter, logger, config }`. Replaces v1's three hand-wired 15–25-closure deps-builders. Frozen contract.

### 6.8 `coordinator/PipelineCoordinator.ts` — thin coordinator
~400–600 LOC (vs v1's 2877). Lifecycle entry points (`start`, `approve`, `reject`, `confirmPush`, `cancelPush`, `cancel`) each **produce a `LifecycleOutcome`** handled by the same exhaustive applier as stage outcomes (full abstraction — no inline `store.update + emit`). Sequences stages through `transition()`. Holds no FSM rules (in the table) and no untyped state (typed IntermediateState). Pure coordination.

### 6.9 `provider/LlmProvider.ts` + mock
`LlmProvider { generateText(req); generateTextWithImages?(req); }` (streaming/tool-call added when real providers land). #1 ships only `MockAIService` (ported) + a control surface: declarative knobs for deterministic scenarios. Real adapters implement the same interface later.

### 6.10 Ported facts to honor (survey corrections)
- `ValidationInput = { files: {filePath, content}[], spec? }`; `ValidationIssue = { severity, category, message, filePath?, line?, suggestion? }`; `passed = score >= 60 && errors === 0`, `score = 100 - (errors*10 + warnings*3 + infos*1)`.
- `CriticReviewInput.reviewType: 'spec' | 'code'`; `CriticReviewOutput { approved, overallScore, findings, summary, hasCriticalFinding, maxSeverity }`; `CriticResult = {type:'review',data} | {type:'error',error}`; default `approvalThreshold = 75`.

## 7. Data flow — one full mock run (happy path)

1. `coordinator.start(idea)` → `ScribeStage` (mock: spec) → `critic_reviewing_spec` → `Critic.reviewSpec` (mock: approved) → `transition(→awaiting_approval)`.
2. `coordinator.approve()` → `transition(→proto_building)` → `ProtoStage` (mock: files via `MockGitHubAdapter`).
3. `postProtoQualityGates`: `Validator.validate` (pass) → `transition(→critic_reviewing_code)` → `Critic.reviewCode` (mock: approved) → `ready_for_trace` → `transition(→trace_testing)` → `TraceStage` dryRun (mock: ≥1 test) → `verified=true`.
4. `transition(→awaiting_push_confirm)`.
5. `coordinator.confirmPush()` mints `ApprovedPush` → `pushToGitHub(token)` (MockGitHubAdapter) → `transition(→completed)`.

**Branches:**
- **Critic code-iterate (non-critical, within budget):** `postProtoQualityGates` → `critic_iterate` → `transition(→fix_loop_iteration → proto_building)` with feedback → Proto re-runs → gate re-runs. Capped at the shared budget (3).
- **Trace-iterate (tests fail, within budget):** Trace `failed` outcome → `iterate` → `fix_loop_iteration → proto_building` with feedback. Same shared budget.
- **Budget exhausted / critical finding:** `transition(→awaiting_critic_resolution)`, **no** token mintable.
- **Trace 0 real tests:** `verified=false`, render `⚠️`, never `completed`.
- **Any stage error:** `transition(→failed)`.

## 8. The day-1 contract test (TDD lock)

`backend/test/contract/pipeline-verified-spine.contract.test.ts` — vitest, `AI_PROVIDER=mock`, MockGitHubAdapter, a recording `emit` capturing the ordered activity stream. No network/keys. Written first (red), drives the build to green.

- **Scenario A — happy path:** strict ordered sequence `scribe → critic(spec) → [awaiting_approval] → approve → proto → validator → critic(code) → trace → [awaiting_push_confirm] → confirmPush → completed`; `ApprovedPush` mintable **only after** `confirmPush`; ends `verified=true`; exhaustive handler hit no `never`.
- **Scenario B — critic code-block:** `mockCriticScore=40` (critical) → chain halts at `awaiting_critic_resolution`; **no** `ApprovedPush` constructible; never reaches `awaiting_push_confirm`.
- **Scenario C — vacuous-green guard:** `mockTraceTestCount=0` → `verified=false`, render `⚠️`, never `completed`/`✅`.
- **Scenario D — iterate then converge:** `mockCriticScore` low-but-non-critical for the first 2 Proto passes, then passing → chain takes `fix_loop_iteration → proto_building` twice (counter increments, shared budget respected), then proceeds to `awaiting_push_confirm`; assert it does **not** exceed the cap.
- **Scenario E — iterate budget exhausted:** persistent failing Trace → loop runs to the cap (3), then halts at `awaiting_critic_resolution`; **no** `ApprovedPush`; never `completed`.
- **Cross-cutting — emit lock:** every `transition()` emits exactly one activity; **atomicity** — after each transition `store.getById(id).stage === ` the stage on the last emitted activity (no store/SSE divergence).

This is the regression tripwire: any later refactor that breaks the chain, gate order, push-gate, or no-false-green rule goes red.

## 9. Error handling
- Stage errors → `StageOutcome` error variant → `transition(→failed)` with a typed `PipelineError` + emitted activity. No throw escapes the coordinator unlogged.
- Illegal transition → typed `IllegalTransitionError` (caught in tests; prod logs + `failed`).
- All mutations under a per-pipeline optimistic lock; `mergeIntermediateState` is the only writer of the bag.

## 10. Testing strategy
- **Framework:** vitest (backend); `AI_PROVIDER=mock`, no network.
- **Unit:** transition (legal/illegal + emit-after-commit), mergeIntermediateState (typed merge, no loss), pushGate (token only via confirm), DeterministicValidator (ported tests), each Stage wrapper, mock knobs.
- **Contract:** §8 (the lock).
- **Smoke:** `scripts/smoke-mock-run.ts` drives one full run and prints the stage timeline (human-eyeball demo of the spine, mock).
- **Store:** `MockPipelineStore` for unit/contract speed; one integration test exercises `DrizzlePipelineStore` (Postgres, optimistic locking + JSONB merge).

## 11. Build order (8 steps, mergeable)
1. **Scaffold + contract test (red):** pnpm workspace (`backend/frontend/shared`), vitest, the frozen `shared/` contracts, and the §8 contract test written against the not-yet-built `PipelineCoordinator` (fails to compile/run = TDD red baseline).
2. **Port pure IP (no orchestration):** CriticAgent + types + 2 prompts; DeterministicValidator + checks + ValidatorTypes; AIService interface + MockAIService + factory + providerDefaults + env resolution; PipelineActivity shape + pipelineBus + ring buffer + stream plugin. Independently mergeable.
3. **Typed-state foundation:** `IntermediateState` + `mergeIntermediateState`; adapt `PipelineTypes` (keep stage union, swap to typed bag); `PipelineStore` interface + `MockPipelineStore`.
4. **FSM seam:** `transitionTable` + `transition()` (atomic update + emit-after-commit + version check); `Stage` + `StageOutcome`; reuse `ProtoTraceOutcome`/`TraceOutcome`.
5. **DI + adapters:** `OrchestratorServices`; `buildGenerateText` adapter; `MockGitHubAdapter`.
6. **Wrap agents + lifecycle as stages:** `ScribeStage` (→`ScribeOutcome`, incl. spec-review critic), `ProtoStage` (text-only + MockGitHub), `TraceStage` (dryRun/inputFiles), and `LifecycleOutcome` handling for approve/reject/confirmPush/cancelPush/cancel (full abstraction — no inline mutation).
7. **The one gate runner + iterate loop + push gate:** `postProtoQualityGates` (Validator→Critic(code)→iterate-eval→ready/hard-block); unified `IterateLoop` (shared budget, `fix_loop_iteration → proto_building`, cancel-race guard via `transition()`); `pushGate` with branded `ApprovedPush`; wire `trace_testing → awaiting_push_confirm → pushGate → completed`.
8. **Green + smoke:** make the contract test pass on the new spine (Scenarios A–E + emit/atomicity locks); `scripts/smoke-mock-run.ts` prints a correct timeline.

## 12. Risks
- **Stack-agnostic Proto prompt:** v1's scaffold prompt is React/Vite/Sandpack-specific. Cosmetic for mock #1; flagged for the real-AI sub-project.
- **Transition-table fidelity:** a mis-mapped edge could block a valid change. Mitigate by deriving from v1's `assertStage` allowlists + the every-transition-emits test.
- **Typed IntermediateState** surfaces latent mismatches as compile errors (intended; sizable initial diff). Land interface + merge first, tighten call sites after.
- **Scope creep:** the studio vision is large; #1 is deliberately backend-spine-only. Resist pulling FE/preview/analytics forward until the spine is locked.

## 13. Definition of done (sub-project #1)
- `pnpm -C backend test` green: contract test (Scenarios A–E) + emit/atomicity locks + unit tests.
- `tsc` strict clean across `shared/` + `backend/`.
- `scripts/smoke-mock-run.ts` prints a correct full-run timeline: `completed`/`verified=true` (happy) and `⚠️` (vacuous-green).
- The spine **cannot** push without `ApprovedPush` (compile-time) and **cannot** render `✅` without a real test (runtime, asserted).
- All on branch `feat/verified-spine-mock`; backend work in one or more reviewable PRs; BE/FE always separate PRs.
