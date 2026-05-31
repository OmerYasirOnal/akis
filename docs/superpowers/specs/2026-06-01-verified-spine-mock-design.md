# Design — Sub-project #1: Provider-agnostic Verified Pipeline Spine (on mock)

> **Status:** design, awaiting approval.
> **Date:** 2026-06-01.
> **Scope:** the FIRST vertical slice of `akis-platform-mvp`. Builds the verification chain end-to-end on the **mock** provider, locked by a backend **contract test** before anything else stacks on it.
> **Source of truth for the rebuild:** `../../../HANDOFF.md` + `../../../docs/v1-architecture-audit.md`. Evidence for this spec: the 2026-06-01 read-only survey of AKIS v1 (`/Users/omeryasironal/Projects/akis-platform`).

---

## 1. Context

AKIS v1 is a working Fastify+React thesis platform whose value is one linear, human-in-the-loop **verification chain**:

```
Scribe (idea→spec) → HUMAN APPROVAL GATE → Proto (spec→code)
  → DeterministicValidator → Critic (adversarial review) → Trace (code→tests, auto-run)
  → PUSH-CONFIRM GATE → GitHub
```

v1 works but its three pains (crowded chat, crowded orchestrator, "fix one bug → spawn another" + parallel-session collisions) share **one root cause**: low-altitude monolith files with no vertical seams (2877-line orchestrator, 1359-line `ChatMessage`) plus shared mutable surfaces (untyped `intermediateState` bag; 57-prop bag; a 15-value `uiState` re-listed in 4 files).

This MVP is a **clean rebuild** (parallel to v1; v1 stays the untouched 2026-06-12 defense demo). The long-term target is a full provider-agnostic studio (live preview, analytics, AI-futuristic UI, own skills, parallel-agent live streaming). We build it as a sequence of sub-projects, **starting from the spine**, because every later surface is a consumer of it.

## 2. The thesis invariants (NON-NEGOTIABLE — design these in from day one)

1. **"Verified" = a real test run, code-enforced.** A run renders `verified` only after Trace produced **≥1 real test** that actually executed. Zero tests or an empty/no-op test run renders `⚠️ unverified`, never `✅`. (The akis-v2 "no false green" lesson.)
2. **Producer ≠ verifier path.** Proto produces code; the Validator→Critic→Trace gate evaluates it. These are distinct stages with distinct outputs; the chain order is fixed.
3. **Push is unreachable until approved — structurally.** GitHub push requires an `ApprovedPush` **branded token** that only the push-confirm gate can mint. Code that tries to push without it does not compile. (Not per-path discipline — a compile-time guarantee.)
4. **One verification-chain runner.** Exactly one `postProtoQualityGates(ctx, input, dryRun)`; never re-implemented per path. (v1 had it in 5 places; one bypassed all gates.)
5. **Forgotten-emit is impossible.** Stage changes go through `transition()`, which does `store.update({stage})` **and** emits the SSE activity as one atomic step. No stage can change silently.

A breach of any invariant is a build failure, asserted by the contract test (§8).

## 3. Scope of sub-project #1

**In scope (this spec):**
- The backend spine: FSM + typed state + Stage plugins + the single quality-gate runner + the push gate.
- Ported IP: Scribe/Proto/Trace/Critic agents + their prompts, DeterministicValidator, the mock provider.
- A narrow `LlmProvider` interface with the **mock** implementation only.
- The human gates' backend lifecycle: approve / reject / confirmPush / cancelPush (via `transition()`).
- The day-1 **contract test** (3 scenarios) + a CLI smoke that drives one full mock run.
- Repo scaffold: `backend/ + frontend/ + shared/` pnpm workspace; `shared/` holds frozen contracts (PipelineStage, events, IntermediateState).

**Out of scope (deferred to later sub-projects, but designed not to require a rewrite):**
- Real providers (Anthropic/OpenAI/Gemini/OpenRouter) + provider/model selection UI + key management → real-AI sub-project. The `LlmProvider` interface keeps the spine provider-agnostic now; real adapters slot in later.
- The frontend chat shell, live step streaming, top-right live preview, analytics page, AI-futuristic UI → FE sub-projects. (`frontend/` is scaffolded but mostly empty in #1.)
- Skills system → studio sub-project. (Scribe already accepts `SkillRegistry` injection, so adding it later is additive, not a rewrite.)
- DevAgent → omitted; later either folded into a verified iterate loop or labeled "unverified".
- The verified **iterate loop** (Proto-iterate → gate), CI polling (`ci_running`), RAG/knowledge injection → later.

## 4. Repo structure

```
akis-platform-mvp/
  package.json            # pnpm workspace root
  pnpm-workspace.yaml     # packages: backend, frontend, shared
  shared/                 # FROZEN cross-session contracts (no runtime deps)
    src/
      pipeline/
        stages.ts         # PipelineStage union + isTerminalStage
        events.ts         # AkisEvent / PipelineActivity SSE shapes
        intermediateState.ts  # typed IntermediateState interface
      index.ts
  backend/                # Fastify 4 + TS strict
    src/
      pipeline/
        fsm/              # transitionTable.ts, transition.ts
        stages/           # Stage.ts, scribeStage.ts, protoStage.ts, traceStage.ts, postProtoQualityGates.ts
        gates/            # pushGate.ts (branded ApprovedPush), approvalGate, criticGate (backend lifecycle)
        agents/           # scribe/, proto/, trace/, critic/ (ported IP + prompts)
        validator/        # DeterministicValidator.ts (ported verbatim)
        provider/         # LlmProvider.ts (interface) + mock/ (ported mock + scenarios.ts)
        services/         # OrchestratorServices.ts (DI container)
        store/            # PipelineStore interface + DrizzlePipelineStore + InMemoryStore (tests)
        coordinator/      # PipelineCoordinator.ts (thin)
        activity/         # activityEmitter (SSE bus + DB dual-write), adapted into transition()
    test/
      contract/           # verified-spine.contract.test.ts (the day-1 lock)
      unit/               # transition, intermediateState, gate, validator tests
    scripts/
      smoke-mock-run.ts   # CLI: drive one full mock run, print the stage timeline
  frontend/               # React 19 + Vite 7 + Tailwind v4 (scaffold only in #1)
  docs/superpowers/specs/ # this spec
```

`shared/` is the only surface multiple parallel sessions import; it is frozen first so backend lanes never collide on it.

## 5. Architecture

### 5.1 PipelineStage (frozen in `shared/`)
In-scope stages for #1:
```
scribe_clarifying | scribe_generating | critic_reviewing_spec | awaiting_approval
| proto_building | critic_reviewing_code | awaiting_critic_resolution
| trace_testing | awaiting_push_confirm | completed | failed | cancelled
```
Deferred (not in #1's table yet): `fix_loop_iteration`, `ci_running`, `completed_partial`. The table is **derived from v1's existing `assertStage` allowlists** — we encode current legal behavior, we do not redesign the FSM.

### 5.2 `fsm/transitionTable.ts` + `fsm/transition.ts`
- `transitionTable: Record<PipelineStage, PipelineStage[]>` — legal targets per stage. `failed`/`cancelled` reachable from any non-terminal.
- `transition(id, to, ctx)`: reads fresh state under lock → asserts `to ∈ table[from]` → `store.update({stage: to, ...})` → **emits the SSE activity via the injected emitter** — all in one atomic step. Returns the new state. This is the single choke-point for stage truth; it makes forgotten-emit impossible and fixes v1's dead-emit channel.
- `TransitionCtx` (store, emit, lock) is a **frozen contract**.

### 5.3 `shared/intermediateState.ts` + `fsm/mergeIntermediateState`
- Replace v1's `Record<string,unknown>` with a typed interface enumerating the cross-stage keys (spine subset): `validationResult`, `criticSpecOutput`, `criticCodeOutput`, `criticBlock`, `acCoverage`, `imageBlocks`, `iterationHistory`, `autoApproved`, … (full v1 key inventory typed; iterate/CI keys included as optional for forward-compat).
- `mergeIntermediateState(store, id, patch)` — the ONE read-modify-write, under lock. A typo becomes a compile error; last-writer-wins races are fixed centrally.

### 5.4 `stages/Stage.ts` — uniform plugin interface
```ts
interface Stage<I, O extends StageOutcome> {
  id: PipelineStage;
  run(ctx: StageContext, input: I): Promise<O>;
}
```
- `StageContext` exposes `store`, `services`, `transition`, `mergeIntermediateState`, `emit`.
- `StageOutcome` is a **discriminated union** with an exhaustive `never` handler — the ONE place side-effects + transitions fire. This is v1's proven `ProtoTraceOutcome`/`TraceOutcome` pattern, now also covering Scribe + lifecycle (which v1 never converted).
- `scribeStage`, `protoStage`, `traceStage` are thin wrappers around the **ported** agents.

### 5.5 `stages/postProtoQualityGates.ts` — THE single runner
`postProtoQualityGates(ctx, input, dryRun)` runs, in canonical order: **DeterministicValidator → Critic.reviewCode → Trace.execute**, returning a discriminated outcome (`proceed-to-push` | `critic-block` | `trace-fail` | `unverified`). Every change-path uses this one runner. The `verified` flag is set true **only** when Trace ran ≥1 real test (invariant #1).

### 5.6 `gates/pushGate.ts` — branded approval token
```ts
type ApprovedPush = { readonly __brand: 'ApprovedPush'; pipelineId: string };
// only confirmPush() can mint an ApprovedPush; pushToGitHub(token: ApprovedPush) requires it.
```
`pushToGitHub` (and any GitHub write) takes `ApprovedPush`. Nothing else can construct the token. Push without approval does not type-check. (In #1 the GitHub write is stubbed/mock; the token machinery is real and tested.)

### 5.7 `services/OrchestratorServices.ts` — DI container
A single object built once (in a factory), carrying agents, provider, validator, store, emitter, config. Replaces v1's three hand-wired 15–25-closure deps-builders. Frozen contract for parallel sessions.

### 5.8 `coordinator/PipelineCoordinator.ts` — thin coordinator
~400–600 LOC (vs v1's 2877). Owns lifecycle entry points (`start`, `approve`, `reject`, `confirmPush`, `cancelPush`, `cancel`) and sequences stages through `transition()`. Holds no FSM rules (table) and no untyped state (typed IntermediateState). Pure coordination.

### 5.9 `provider/LlmProvider.ts` + mock
```ts
interface LlmProvider {
  generateText(req): Promise<LlmResult>;
  generateTextWithImages?(req): Promise<LlmResult>;
  // streaming/tool-call added when real providers land
}
```
Sub-project #1 ships only `MockProvider` (ported from v1's deterministic keyword-driven mock) + `mock/scenarios.ts` (deterministic responses for the 3 contract scenarios). Real adapters implement the same interface later.

## 6. Ported IP vs write-new (from the survey)

**Port verbatim:** `CriticAgent` + `prompts/spec-review.ts` + `prompts/code-review.ts`; `DeterministicValidator`; Scribe prompts (CLARIFICATION + SPEC_GENERATION); Trace test-gen prompt; the outcome-union/`never` pattern; the mock provider (`core/mock/*`).

**Port-adapt:** Scribe state machine (clarify/generate, max-3 rounds — strip orchestrator coupling); Proto `SCAFFOLD_SYSTEM_PROMPT` (make stack-agnostic); Trace `execute()` + AC-coverage (adapt to `StageContext`); AIService → narrow `LlmProvider`; McpGateway (service behind Scribe stage); activityEmitter/SSE shapes (fold into `transition()`-emits).

**Write new:** transitionTable, transition, typed IntermediateState + merge, Stage interface, postProtoQualityGates, pushGate branded token, OrchestratorServices, PipelineCoordinator, the stage wrappers, the contract test, mock scenarios.

## 7. Data flow — one full mock run (happy path)

1. `coordinator.start(idea)` → `scribeStage.run` → mock returns spec → `transition(→awaiting_approval)` (emits activity).
2. `coordinator.approve()` → `transition(→proto_building)` → `protoStage.run` → mock returns files.
3. `postProtoQualityGates`: `DeterministicValidator.validate` → `transition(→critic_reviewing_code)` → `Critic.reviewCode` (mock: pass) → `transition(→trace_testing)` → `Trace.execute` (mock: ≥1 real test, pass) → `verified=true`.
4. `transition(→awaiting_push_confirm)`.
5. `coordinator.confirmPush()` mints `ApprovedPush` → `pushToGitHub(token)` (stubbed) → `transition(→completed)`.

Branches: critic critical finding → `transition(→awaiting_critic_resolution)`, no token mintable. Trace 0 real tests → `verified=false`, render `⚠️`. Any stage error → `transition(→failed)`.

## 8. The day-1 contract test (`test/contract/verified-spine.contract.test.ts`)

Runs the full pipeline on the mock provider (zero API cost), asserting via spies on injected services:

- **Scenario A — happy path:** exact ordered sequence `scribe.generateSpec → [awaiting_approval] → approve → proto.execute → DeterministicValidator.validate → critic.reviewCode → trace.execute → [awaiting_push_confirm]`; `ApprovedPush` mintable **only after** `confirmPush`; ends `completed` with `verified=true`.
- **Scenario B — critic-block:** critic returns a critical finding → chain halts at `awaiting_critic_resolution`; **no** `ApprovedPush` is constructible; never reaches `awaiting_push_confirm`.
- **Scenario C — vacuous-green guard:** Trace produces 0 real tests → run is `⚠️ unverified` (`verified=false`), never `completed`/`✅`.
- **Cross-cutting:** every `transition()` emitted exactly one SSE activity (no forgotten-emit, no duplicate).

This test is the regression tripwire: any later refactor that breaks the chain, the gate order, the push-gate, or the no-false-green rule goes red immediately.

## 9. Error handling
- Stage errors → `StageOutcome` error variant → `transition(→failed)` with a typed `PipelineError` + emitted activity. No throw escapes the coordinator unlogged.
- Illegal transition (target ∉ table) → throws a typed `IllegalTransitionError` (caught in tests; in prod logged + `failed`).
- All state mutations under a per-pipeline lock; `mergeIntermediateState` is the only writer of the bag.

## 10. Testing strategy
- **Framework:** vitest (backend). `AI_PROVIDER=mock` for the spine; no network.
- **Unit:** transition (legal/illegal + emits), mergeIntermediateState (typed merge, no last-writer-wins loss), pushGate (token only via confirm), DeterministicValidator (ported tests), each Stage wrapper.
- **Contract:** §8 (the lock).
- **Smoke:** `scripts/smoke-mock-run.ts` drives one full run and prints the stage timeline (human-eyeball demo of the spine, mock).
- **Store:** `InMemoryStore` for tests; `DrizzlePipelineStore` for runtime (Postgres). Contract test uses InMemoryStore for speed; one integration test exercises Drizzle.

## 11. Decisions resolved (the 7 open questions)
| # | Decision |
|---|----------|
| Repo layout | `backend/ + frontend/ + shared/`, root pnpm workspace |
| Skills | Deferred (Scribe keeps `SkillRegistry` injection seam) |
| Mock | Port v1's mock + add `mock/scenarios.ts` for the 3 contract cases |
| Vacuous-green guard | Adopted now (invariant #1) |
| DevAgent | Omitted from #1 |
| Provider-agnostic | Narrow `LlmProvider` + mock only in #1; real adapters later |
| Push-gate token | Branded compile-time type |

## 12. Risks
- **Stack-agnostic Proto prompt:** v1's scaffold prompt is React/Vite/Sandpack-specific. For #1 (mock) this is cosmetic; flagged for the real-AI sub-project.
- **Transition table fidelity:** a mis-mapped legal transition could block a valid change. Mitigate by deriving the table from v1's `assertStage` allowlists and gating on the every-transition-emits test.
- **Typed IntermediateState surfacing latent mismatches** as compile errors (intended, but a real initial diff). Land the interface + merge first, then tighten.
- **Scope creep:** the full studio vision is large. #1 is deliberately backend-spine-only; resist pulling FE/preview/analytics forward until the spine is locked.

## 13. Definition of done (sub-project #1)
- `pnpm -C backend test` green, including the contract test (3 scenarios) + every-transition-emits.
- `tsc` strict clean across `shared/` + `backend/`.
- `scripts/smoke-mock-run.ts` prints a correct full-run timeline ending `completed`/`verified=true` (happy) and `⚠️` (vacuous-green scenario).
- The spine cannot push without `ApprovedPush` (compile-time) and cannot render `✅` without a real test (runtime, asserted).
- All on branch `feat/verified-spine-mock`; BE work is one or more reviewable PRs.
