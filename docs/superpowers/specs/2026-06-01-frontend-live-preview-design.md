# Frontend — Live Preview First (sub-project 5)

**Goal:** A live, Claude-Code-style view of a build session: the agents' steps as
they happen (per-agent/lane step tree), the 4 gates as cards, and a **preview
surface** that shows the produced app + its real test stats. Built live-preview
first; roster / per-agent model picker / workflow presets come after.

**Maps to:** F2-AC7 (live preview of the AkisEvent stream) consuming the resumable
SSE from sub-project 2 (#11), and the **local-first preview/test-env vision** — the
preview surface is designed from day one to host the locally-running app
(`/preview/:sessionId`) **and** Trace's real Playwright+Cucumber test stats
(built / running / passed / performance), per
`2026-06-01-preview-test-env-design.md`. Today it renders what the backend already
emits (`preview` url + `verify` testsRun/passed); the richer stats slot in when the
preview/test-env backend lands — no FE rework, same view-model.

**Invariants:** the FE is a pure consumer — it holds NO gate authority; approve/
push are user actions that POST to the gated routes, which still enforce the gates.
tsc strict clean. The SSE consumer must not lose/duplicate steps across reconnect
(it relies on #11's `seq` + `Last-Event-ID`).

---

## Architecture

Stack: **Vite + React + TypeScript + Tailwind**. Tests: **vitest + @testing-library/react**.
The heart is two framework-agnostic, fully-unit-tested TS modules; React renders them.

```
frontend/src/
  api/client.ts            # typed REST: startSession, getSession, approve, run, confirm, listProviders
  live/EventStreamClient.ts# SSE consumer: connect, parse id:/data:, track lastSeq, resume, 'reset' -> refetch
  live/viewModel.ts        # PURE reducer: AkisEvent[] -> SessionView (step tree, gates, tests, preview, errors)
  live/types.ts            # SessionView, AgentLane, StepNode, GateCard, TestStats, PreviewState
  components/
    NewSessionForm.tsx     # idea -> POST /sessions
    SessionView.tsx        # orchestrates the live view for a session id
    StepTree.tsx           # per-agent/lane tree of agent_start/tool_call/tool_result/agent_end
    GateCards.tsx          # spec_approval + push_confirm cards w/ Approve / Confirm buttons (user actions)
    PreviewPanel.tsx       # preview URL (iframe when same-origin /preview/:id) + TestStats; placeholder until built
    TestStats.tsx          # built / running / passed + perf — from `verify` now; Playwright/Cucumber later
  app/App.tsx, main.tsx, index.css (tailwind)
```

### Data flow
```
NewSessionForm --POST /sessions--> { id }
SessionView(id):
  - GET /sessions/:id  (initial state, also the 'reset' re-sync target)
  - EventStreamClient.connect(/sessions/:id/events)  (EventSource; auto Last-Event-ID on reconnect)
       each frame -> dispatch(event) -> viewModel reducer -> re-render
       'reset' control -> GET /sessions/:id + resume from head (no lost/dup)
  - user clicks Approve/Confirm -> POST /sessions/:id/approve|confirm ; run auto/!manual
```

### `viewModel.ts` — the pure reducer (mirrors backend, richer for UI)
`foldSessionView(events): SessionView` where:
- `lanes: Record<laneId, AgentLane>` — each lane has ordered `steps: StepNode[]` built
  from `agent_start` (open a node) → `tool_call`/`tool_result` (children) → `agent_end`
  (close, ok). `text` events attach as narration to the current agent.
- `gates: { specApproval?: GateCard; pushConfirm?: GateCard }` from `gate` events
  (state awaiting/satisfied/rejected → drives the Approve/Confirm button enablement).
- `tests: TestStats` from `verify` (`testsRun`, `passed`) — the seam the richer
  Playwright/Cucumber stats extend (scenarios built/running/passed, p95).
- `preview: PreviewState` from `preview` (`url`) + `tool_result(push_to_github)`.
- `errors: string[]` from `error` + failed `tool_result`.
- `status` from `session`/`done`. `provider` from `done`.
This is the same projection idea as the backend scratchpad, extended with the step
tree; **pure, deterministic, fully unit-tested** (the highest-value FE test).

### `EventStreamClient.ts`
- `connect(url, { onEvent, onReset, onError })`. Uses `EventSource` (auto-resume via
  `Last-Event-ID`). Parses `id:`/`data:`; on a `reset` control event calls `onReset`
  (the view refetches `GET /sessions/:id`). Tracks `lastSeq`. Injectable EventSource
  factory so it's testable without a browser (a fake emitting frames).

---

## Testing (TDD — failing test first)
1. **viewModel.test.ts** (pure, no DOM): a scripted AkisEvent[] folds into the
   expected SessionView — step tree nesting (agent_start→tool_call→tool_result→
   agent_end), gate states, test stats from `verify`, preview url, errors; an
   out-of-order/duplicate seq is idempotent (fold is by content, last-wins).
2. **EventStreamClient.test.ts**: with a fake EventSource, frames → onEvent in
   order; a `reset` frame → onReset; tracks lastSeq.
3. **api/client.test.ts**: with fetch mocked, each call hits the right method/url
   and maps 409/404 to typed errors.
4. **components** (@testing-library): NewSessionForm submits idea; GateCards shows
   Approve enabled only when spec_approval is `awaiting`; PreviewPanel shows the url
   when present and the TestStats; StepTree renders lanes/steps. (Lighter than the
   reducer tests — the logic lives in the tested reducer.)
5. **tsc --noEmit** strict clean; `frontend` typecheck wired into the workspace.

## Out of scope (later sub-projects)
- Roster + per-agent **model picker** (consumes `/api/providers`) and **workflow
  presets** editor — the next FE sub-project.
- The actual **local preview/test-env backend** (Workspace/Runner/proxy + real
  Playwright/Cucumber TestRunner) — its own backend sub-project; this FE renders its
  output through the already-designed `PreviewState`/`TestStats` seam.
- Auth screens, multi-session dashboard, theming beyond the base AI-futuristic look.
