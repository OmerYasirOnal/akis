# Agentic Core + 4 Structural Gates — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the provider-agnostic agentic orchestration core for `akis-platform-mvp` — a conversational main orchestrator that dispatches Scribe/Proto/Trace/Critic sub-agents with **4 structural verification gates**, running end-to-end on a mock provider, locked by a contract test.

**Architecture:** Own agent loop (`think→tool→observe`) over a narrow `LlmProvider`. The orchestrator decides flow (no rigid FSM); 4 invariants are enforced structurally at the type/permission layer: (1) spec-approval gate, (2) producer≠verifier role-based tool permission, (3) `verified` = a real ≥1-test pass (event reducer), (4) push gate = branded `ApprovedPush` token requiring verified + human confirm. A three-layer prompt/skill model (role in code · thin base prompt · `.md`+frontmatter skill library) carries use-case intelligence. All events stream as a tagged `AkisEvent` union.

**Tech Stack:** TypeScript (strict) · pnpm workspace (`backend`/`frontend`/`shared`) · Fastify 4 · vitest · mock provider only (real adapters come later).

**Spec:** `docs/superpowers/specs/2026-06-01-agentic-core-gates-design.md`
**Branch:** `feat/agentic-core-gates`

---

## File structure (what each file owns)

```
shared/src/
  roles.ts          # Role union + ToolName (the producer≠verifier source of truth)
  events.ts         # AkisEvent discriminated union (agent + laneId tagged)
  session.ts        # SessionState, status, typed artifacts
  index.ts          # re-exports
backend/src/
  agent/
    LlmProvider.ts   # provider interface: chat(); ChatRequest/Result, ToolSpec
    AgentLoop.ts     # generic think→tool→observe loop; runs tools through permission; emits events
    mock/MockProvider.ts  # scripted tool-calls + knobs (deterministic)
  tools/
    registry.ts      # ToolSpec registry (dispatch_*, run_tests, request_*, push_to_github)
    permission.ts    # canUseTool(role, tool, ctx) → ok | denied  (Gates 1 & 2)
  gates/
    verifiedReducer.ts  # deriveVerified(events) → boolean  (Gate 3)
    pushGate.ts         # branded ApprovedPush; mintApprovedPush(); pushToGitHub(token)  (Gate 4)
  events/bus.ts      # EventBus: emit + ring buffer + subscribe
  skills/
    registry.ts      # load .md+frontmatter, selectSkills(), buildSystemPrompt()
    library/**.md    # researched draft skills (status: draft) — authored in Task 13
  prompts/*.base.md  # thin per-agent base prompts
  validator/         # DeterministicValidator + checks (ported from v1)
  orchestrator/
    subagents/        # ScribeAgent, ProtoAgent, TraceAgent, critic/CriticAgent
    parallel.ts       # fan-out + join with per-lane events
    Orchestrator.ts   # main conversational agent: toolset + session state + narration + skill selection
  store/
    SessionStore.ts   # interface
    MockSessionStore.ts  # in-memory (tests)
  di/
    services.ts        # OrchestratorServices container
    MockGitHubAdapter.ts
backend/test/
  unit/...            # per-module unit tests
  contract/agentic-gates.contract.test.ts  # the 4-gate lock (Scenarios A–F)
backend/scripts/smoke-mock-run.ts  # live timeline demo
```

---

## Task 1: Workspace scaffold + tooling

**Files:** Create `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `shared/package.json`, `shared/tsconfig.json`, `backend/package.json`, `backend/tsconfig.json`, `backend/vitest.config.ts`, `frontend/package.json`.

- [ ] **Step 1: `pnpm-workspace.yaml`**
```yaml
packages:
  - shared
  - backend
  - frontend
```

- [ ] **Step 2: root `package.json`**
```json
{
  "name": "akis-platform-mvp",
  "private": true,
  "packageManager": "pnpm@9.0.0",
  "type": "module",
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -C backend test",
    "typecheck": "pnpm -r typecheck"
  }
}
```

- [ ] **Step 3: `tsconfig.base.json`**
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "declaration": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

- [ ] **Step 4: `shared/package.json` + `shared/tsconfig.json`**
```json
{
  "name": "@akis/shared",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc --noEmit" }
}
```
```json
{ "extends": "../tsconfig.base.json", "include": ["src"] }
```

- [ ] **Step 5: `backend/package.json` + `backend/tsconfig.json` + `backend/vitest.config.ts`**
```json
{
  "name": "@akis/backend",
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "smoke": "tsx scripts/smoke-mock-run.ts"
  },
  "dependencies": {
    "@akis/shared": "workspace:*",
    "fastify": "^4.28.0",
    "gray-matter": "^4.0.3"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```
```json
{ "extends": "../tsconfig.base.json", "include": ["src", "test", "scripts"] }
```
```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
})
```

- [ ] **Step 6: `frontend/package.json` (placeholder)**
```json
{
  "name": "@akis/frontend",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": { "typecheck": "echo \"frontend scaffolded in a later sub-project\"" }
}
```

- [ ] **Step 7: Install + commit**
Run: `pnpm install` (expect: `@akis/shared` linked into backend).
```bash
git add -A && git commit -m "chore: pnpm workspace scaffold (shared/backend/frontend) + tooling"
```

---

## Task 2: Frozen `shared` contracts (roles, events, session)

**Files:** Create `shared/src/{roles.ts,events.ts,session.ts,index.ts}`; Test `backend/test/unit/shared-contracts.test.ts`.

- [ ] **Step 1: `shared/src/roles.ts`**
```ts
export type Role = 'orchestrator' | 'scribe' | 'proto' | 'trace' | 'critic'

/** Trace is the only verifier. */
export const VERIFIER_ROLE: Role = 'trace'

export type ToolName =
  | 'dispatch_scribe' | 'dispatch_proto' | 'dispatch_trace' | 'dispatch_critic'
  | 'run_tests'
  | 'request_spec_approval' | 'request_push_confirm'
  | 'push_to_github'
  | 'ask' | 'chat'
```

- [ ] **Step 2: `shared/src/events.ts`**
```ts
import type { Role, ToolName } from './roles.js'

export interface BaseEvent { sessionId: string; agent: Role; laneId: string; ts: number }

export type AkisEvent =
  | (BaseEvent & { kind: 'session'; status: 'started' | 'failed' | 'done' })
  | (BaseEvent & { kind: 'text'; text: string })
  | (BaseEvent & { kind: 'agent_start'; role: Role })
  | (BaseEvent & { kind: 'agent_end'; role: Role; ok: boolean })
  | (BaseEvent & { kind: 'tool_call'; tool: ToolName; args: unknown })
  | (BaseEvent & { kind: 'tool_result'; tool: ToolName; ok: boolean; result?: unknown })
  | (BaseEvent & { kind: 'gate'; gate: 'spec_approval' | 'push_confirm'; state: 'awaiting' | 'satisfied' | 'rejected' })
  | (BaseEvent & { kind: 'verify'; testsRun: number; passed: boolean })
  | (BaseEvent & { kind: 'preview'; url: string })
  | (BaseEvent & { kind: 'done'; verified: boolean; provider: string })
  | (BaseEvent & { kind: 'error'; message: string; code?: string })
```

- [ ] **Step 3: `shared/src/session.ts`**
```ts
export type SessionStatus =
  | 'composing' | 'awaiting_spec_approval' | 'building'
  | 'awaiting_push_confirm' | 'done' | 'failed' | 'cancelled'

export interface SpecArtifact { title: string; body: string }
export interface CodeArtifact { files: { filePath: string; content: string }[] }

export interface SessionState {
  id: string
  status: SessionStatus
  idea: string
  spec?: SpecArtifact
  approvedSpec?: SpecArtifact   // set only by human approve(); Gate 1 keys on this
  code?: CodeArtifact
  verified: boolean             // set only by verifiedReducer; Gate 3
  version: number               // optimistic lock
}

export function initialSession(id: string, idea: string): SessionState {
  return { id, status: 'composing', idea, verified: false, version: 0 }
}
```

- [ ] **Step 4: `shared/src/index.ts`**
```ts
export * from './roles.js'
export * from './events.js'
export * from './session.js'
```

- [ ] **Step 5: `backend/test/unit/shared-contracts.test.ts`**
```ts
import { describe, it, expect } from 'vitest'
import { initialSession, VERIFIER_ROLE } from '@akis/shared'

describe('shared contracts', () => {
  it('initial session is unverified and composing', () => {
    const s = initialSession('s1', 'build a todo app')
    expect(s.verified).toBe(false)
    expect(s.status).toBe('composing')
    expect(s.approvedSpec).toBeUndefined()
  })
  it('the verifier role is trace', () => {
    expect(VERIFIER_ROLE).toBe('trace')
  })
})
```

- [ ] **Step 6: Run + commit**
Run: `pnpm -C backend test shared-contracts` (expect PASS, 2 tests). `pnpm -C shared typecheck && pnpm -C backend typecheck` (expect clean).
```bash
git add shared backend/test/unit/shared-contracts.test.ts
git commit -m "feat(shared): frozen contracts — roles, events, session"
```

---

## Task 3: `LlmProvider` interface + `MockProvider`

**Files:** Create `backend/src/agent/LlmProvider.ts`, `backend/src/agent/mock/MockProvider.ts`; Test `backend/test/unit/mock-provider.test.ts`.

- [ ] **Step 1: Write the failing test**
```ts
import { describe, it, expect } from 'vitest'
import { MockProvider } from '../../src/agent/mock/MockProvider.js'

describe('MockProvider', () => {
  it('returns scripted tool calls in order', async () => {
    const p = new MockProvider({ script: [
      { toolCalls: [{ name: 'dispatch_scribe', args: { idea: 'x' } }] },
      { text: 'done' },
    ] })
    const a = await p.chat({ role: 'orchestrator', system: '', messages: [], tools: [] })
    expect(a.toolCalls?.[0].name).toBe('dispatch_scribe')
    const b = await p.chat({ role: 'orchestrator', system: '', messages: [], tools: [] })
    expect(b.text).toBe('done')
  })
  it('exposes knobs for deterministic scenarios', () => {
    const p = new MockProvider({ script: [], knobs: { mockTraceTestCount: 0 } })
    expect(p.knobs.mockTraceTestCount).toBe(0)
  })
})
```

- [ ] **Step 2: Run → FAIL** (`pnpm -C backend test mock-provider`; "Cannot find module").

- [ ] **Step 3: `backend/src/agent/LlmProvider.ts`**
```ts
import type { Role } from '@akis/shared'

export interface ToolSpec { name: string; description: string; schema: unknown }
export interface ChatMessage { role: 'user' | 'assistant' | 'tool'; content: string; toolName?: string }
export interface ChatRequest { role: Role; system: string; messages: ChatMessage[]; tools: ToolSpec[] }
export interface ToolCall { name: string; args: unknown }
export interface ChatResult { text?: string; toolCalls?: ToolCall[]; usage?: { inTokens: number; outTokens: number } }

export interface LlmProvider { readonly name: string; chat(req: ChatRequest): Promise<ChatResult> }
```

- [ ] **Step 4: `backend/src/agent/mock/MockProvider.ts`**
```ts
import type { LlmProvider, ChatRequest, ChatResult } from '../LlmProvider.js'

export interface MockKnobs {
  mockNeedsClarification?: boolean
  mockCriticScore?: number
  mockTraceTestCount?: number
  mockProtoFixesOnIterate?: boolean
}
export interface MockTurn { text?: string; toolCalls?: ChatResult['toolCalls'] }
export interface MockConfig { script: MockTurn[]; knobs?: MockKnobs }

export class MockProvider implements LlmProvider {
  readonly name = 'mock'
  readonly knobs: MockKnobs
  private i = 0
  constructor(private cfg: MockConfig) { this.knobs = cfg.knobs ?? {} }
  async chat(_req: ChatRequest): Promise<ChatResult> {
    const turn = this.cfg.script[this.i++]
    if (!turn) return { text: '' }
    return { text: turn.text, toolCalls: turn.toolCalls }
  }
}
```

- [ ] **Step 5: Run → PASS; typecheck; commit**
```bash
git add backend/src/agent backend/test/unit/mock-provider.test.ts
git commit -m "feat(agent): LlmProvider interface + scripted MockProvider"
```

---

## Task 4: Event bus

**Files:** Create `backend/src/events/bus.ts`; Test `backend/test/unit/bus.test.ts`.

- [ ] **Step 1: Failing test**
```ts
import { describe, it, expect } from 'vitest'
import { EventBus } from '../../src/events/bus.js'
import type { AkisEvent } from '@akis/shared'

const ev = (over: Partial<AkisEvent> = {}): AkisEvent =>
  ({ sessionId: 's1', agent: 'orchestrator', laneId: 'main', ts: 1, kind: 'text', text: 'hi', ...over } as AkisEvent)

describe('EventBus', () => {
  it('emits to subscribers and records to the ring buffer', () => {
    const bus = new EventBus(10); const seen: AkisEvent[] = []
    bus.subscribe('s1', e => seen.push(e)); bus.emit(ev())
    expect(seen).toHaveLength(1); expect(bus.recent('s1')).toHaveLength(1)
  })
  it('caps the ring buffer', () => {
    const bus = new EventBus(2)
    for (let i = 0; i < 5; i++) bus.emit(ev({ ts: i }))
    expect(bus.recent('s1')).toHaveLength(2)
    expect(bus.recent('s1')[0].ts).toBe(3)
  })
})
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: `backend/src/events/bus.ts`**
```ts
import type { AkisEvent } from '@akis/shared'
type Listener = (e: AkisEvent) => void

export class EventBus {
  private listeners = new Map<string, Set<Listener>>()
  private buffers = new Map<string, AkisEvent[]>()
  constructor(private readonly cap = 200) {}
  subscribe(sessionId: string, fn: Listener): () => void {
    const set = this.listeners.get(sessionId) ?? new Set()
    set.add(fn); this.listeners.set(sessionId, set)
    return () => set.delete(fn)
  }
  emit(e: AkisEvent): void {
    const buf = this.buffers.get(e.sessionId) ?? []
    buf.push(e)
    if (buf.length > this.cap) buf.splice(0, buf.length - this.cap)
    this.buffers.set(e.sessionId, buf)
    this.listeners.get(e.sessionId)?.forEach(fn => fn(e))
  }
  recent(sessionId: string): AkisEvent[] { return [...(this.buffers.get(sessionId) ?? [])] }
}
```

- [ ] **Step 4: Run → PASS; commit**
```bash
git add backend/src/events backend/test/unit/bus.test.ts
git commit -m "feat(events): EventBus with subscribe + capped ring buffer"
```

---

## Task 5: Tool registry + permission layer (Gates 1 & 2)

The new load-bearing seam — producer≠verifier + spec-approval enforced here.

**Files:** Create `backend/src/tools/permission.ts`, `backend/src/tools/registry.ts`; Test `backend/test/unit/permission.test.ts`.

- [ ] **Step 1: Failing test (every role × gated tool)**
```ts
import { describe, it, expect } from 'vitest'
import { canUseTool } from '../../src/tools/permission.js'
import { initialSession } from '@akis/shared'

const base = initialSession('s1', 'idea')

describe('canUseTool — Gate 2 (producer≠verifier)', () => {
  it('only the verifier (trace) may run_tests', () => {
    expect(canUseTool('trace', 'run_tests', base).ok).toBe(true)
    for (const r of ['orchestrator', 'proto', 'scribe', 'critic'] as const) {
      const v = canUseTool(r, 'run_tests', base)
      expect(v.ok).toBe(false)
      if (!v.ok) expect(v.reason).toMatch(/verifier/i)
    }
  })
})
describe('canUseTool — Gate 1 (spec approval)', () => {
  it('dispatch_proto denied until approvedSpec exists', () => {
    expect(canUseTool('orchestrator', 'dispatch_proto', base).ok).toBe(false)
    const approved = { ...base, approvedSpec: { title: 't', body: 'b' } }
    expect(canUseTool('orchestrator', 'dispatch_proto', approved).ok).toBe(true)
  })
})
describe('canUseTool — push needs a token (Gate 4 handoff)', () => {
  it('push_to_github denied without an ApprovedPush in ctx', () => {
    expect(canUseTool('orchestrator', 'push_to_github', base).ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: `backend/src/tools/permission.ts`**
```ts
import type { Role, ToolName, SessionState } from '@akis/shared'
import { VERIFIER_ROLE } from '@akis/shared'

export type PermissionVerdict = { ok: true } | { ok: false; reason: string }
export interface PermissionCtx { hasApprovedPushToken?: boolean }

export function canUseTool(role: Role, tool: ToolName, session: SessionState, ctx: PermissionCtx = {}): PermissionVerdict {
  switch (tool) {
    case 'run_tests':
      return role === VERIFIER_ROLE ? { ok: true }
        : { ok: false, reason: `run_tests is restricted to the verifier role (${VERIFIER_ROLE}); '${role}' is a producer` }
    case 'dispatch_proto':
      return session.approvedSpec ? { ok: true }
        : { ok: false, reason: 'dispatch_proto (code-write) requires an approved spec (Gate 1)' }
    case 'push_to_github':
      return ctx.hasApprovedPushToken ? { ok: true }
        : { ok: false, reason: 'push_to_github requires an ApprovedPush token (Gate 4)' }
    default:
      return { ok: true }
  }
}
```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: `backend/src/tools/registry.ts`**
```ts
import type { ToolName } from '@akis/shared'
import type { ToolSpec } from '../agent/LlmProvider.js'

export const TOOL_SPECS: Record<ToolName, ToolSpec> = {
  dispatch_scribe:       { name: 'dispatch_scribe', description: 'Turn the idea into a spec', schema: {} },
  dispatch_proto:        { name: 'dispatch_proto', description: 'Write code from the approved spec', schema: {} },
  dispatch_trace:        { name: 'dispatch_trace', description: 'Generate + run tests (verifier)', schema: {} },
  dispatch_critic:       { name: 'dispatch_critic', description: 'Adversarial review of spec or code', schema: {} },
  run_tests:             { name: 'run_tests', description: 'Execute the test suite (verifier only)', schema: {} },
  request_spec_approval: { name: 'request_spec_approval', description: 'Park for human spec approval', schema: {} },
  request_push_confirm:  { name: 'request_push_confirm', description: 'Park for human push confirmation', schema: {} },
  push_to_github:        { name: 'push_to_github', description: 'Push verified code (needs ApprovedPush)', schema: {} },
  ask:                   { name: 'ask', description: 'Ask the user a question', schema: {} },
  chat:                  { name: 'chat', description: 'Answer without building', schema: {} },
}

export function toolsForRole(names: ToolName[]): ToolSpec[] { return names.map(n => TOOL_SPECS[n]) }
```

- [ ] **Step 6: Run full suite → PASS; commit**
```bash
git add backend/src/tools backend/test/unit/permission.test.ts
git commit -m "feat(tools): role-based permission layer (Gates 1&2) + tool registry"
```

---

## Task 6: Port pure IP — DeterministicValidator + CriticAgent

Ported from v1 (`/Users/omeryasironal/Projects/akis-platform`). Port logic faithfully; adapt import paths + the AI dependency seam (`generateText` → `LlmProvider`).

**Verified-from-v1 contract (the survey had errors — these are the real shapes read from source):**
- `ValidationFile = { path: string; content: string; language: 'typescript'|'javascript'|'json'|'html'|'css' }`
- `ValidationInput = { files: ValidationFile[]; spec?: unknown }`
- `ValidationIssue = { severity: 'error'|'warning'|'info'; category: 'syntax'|'import'|'type'|'security'|'structure'; file: string; line?: number; message: string; rule: string }`
- `ValidationResult = { passed: boolean; score: number; issues: ValidationIssue[]; summary: { errors; warnings; infos; filesChecked; checksRun: string[] } }`; rule `passed = score >= 60 && errors === 0`.
- `CriticReviewInput = { artifact: string; artifactType: 'spec'|'code'; originalIdea: string; referenceSpec?: string; iterationNumber?: number }` (note: `artifactType`, **not** `reviewType`).
- `CriticReviewOutput = { approved; overallScore; summary; findings: CriticFinding[]; strengths?; hasCriticalFinding; maxSeverity: 'critical'|'high'|'medium'|'low'|'info'|'none' }`
- `CriticResult = { type: 'review'|'error'; data?: CriticReviewOutput; error?: PipelineError }`
- `CriticAIDeps = { generateText: (system: string, user: string) => Promise<string>; skillRegistry? }`; `new CriticAgent(deps, config?)` with default `approvalThreshold = 75`; methods `reviewSpec(input)` / `reviewCode(input)`.

> **Note:** Before porting, the executor MUST re-open the v1 source files to copy them verbatim (only the import paths + the `generateText` seam change). Do not retype from memory. Files: `backend/src/pipeline/core/validator/{ValidatorTypes.ts,DeterministicValidator.ts,checks/*}` and `backend/src/pipeline/agents/critic/{CriticAgent.ts,types.ts,prompts/spec-review.ts,prompts/code-review.ts}`.

- [ ] **Step 1: Copy ValidatorTypes + DeterministicValidator + checks** → `backend/src/validator/*`, fixing only relative imports.

- [ ] **Step 2: `backend/test/unit/validator.test.ts`**
```ts
import { describe, it, expect } from 'vitest'
import { DeterministicValidator } from '../../src/validator/DeterministicValidator.js'

describe('DeterministicValidator (ported)', () => {
  it('passes clean files', () => {
    const v = new DeterministicValidator()
    const r = v.validate({ files: [{ path: 'index.ts', content: 'export const x = 1\n', language: 'typescript' }] })
    expect(r.passed).toBe(true)
    expect(r.score).toBeGreaterThanOrEqual(60)
  })
})
```
Run: `pnpm -C backend test validator` (expect PASS; if a v1 check imports something unported, port that dependency or disable that check via the `checks` constructor arg — document which).

- [ ] **Step 3: Copy CriticAgent + types + prompts** → `backend/src/orchestrator/subagents/critic/*`, fixing imports + swapping `CriticAIDeps.generateText` to a `(system,user) => provider.chat(...).text` adapter.

- [ ] **Step 4: `backend/test/unit/critic.test.ts`**
```ts
import { describe, it, expect } from 'vitest'
import { CriticAgent } from '../../src/orchestrator/subagents/critic/CriticAgent.js'

const fakeGenerate = async () => JSON.stringify({
  approved: true, overallScore: 90, summary: 'ok', findings: [],
  hasCriticalFinding: false, maxSeverity: 'none',
})

describe('CriticAgent (ported)', () => {
  it('parses an approved code review', async () => {
    const critic = new CriticAgent({ generateText: fakeGenerate }, { approvalThreshold: 75 })
    const res = await critic.reviewCode({ artifact: 'x', artifactType: 'code', originalIdea: 'y' })
    expect(res.type).toBe('review')
    expect(res.data?.approved).toBe(true)
    expect(res.data?.overallScore).toBe(90)
  })
})
```
Run: `pnpm -C backend test critic` (expect PASS; if the parser is strict, mirror v1's exact code-review output schema in `fakeGenerate`).

- [ ] **Step 5: Commit**
```bash
git add backend/src/validator backend/src/orchestrator/subagents/critic backend/test/unit/validator.test.ts backend/test/unit/critic.test.ts
git commit -m "feat: port DeterministicValidator + CriticAgent (pure IP) onto LlmProvider seam"
```

---

## Task 7: AgentLoop (think→tool→observe, permission-checked, event-emitting)

**Files:** Create `backend/src/agent/AgentLoop.ts`; Test `backend/test/unit/agent-loop.test.ts`.

- [ ] **Step 1: Failing test**
```ts
import { describe, it, expect } from 'vitest'
import { runAgentLoop } from '../../src/agent/AgentLoop.js'
import { MockProvider } from '../../src/agent/mock/MockProvider.js'
import { EventBus } from '../../src/events/bus.js'
import { initialSession } from '@akis/shared'
import type { AkisEvent } from '@akis/shared'

describe('runAgentLoop', () => {
  it('executes permitted tools and emits a tool_call+tool_result per call', async () => {
    const bus = new EventBus(); const events: AkisEvent[] = []
    bus.subscribe('s1', e => events.push(e))
    const session = { ...initialSession('s1', 'idea'), approvedSpec: { title: 't', body: 'b' } }
    const provider = new MockProvider({ script: [
      { toolCalls: [{ name: 'dispatch_proto', args: {} }] },
      { text: 'finished' },
    ] })
    const calls: string[] = []
    await runAgentLoop({
      role: 'orchestrator', system: '', laneId: 'main', sessionId: 's1', session, provider, bus,
      tools: [{ name: 'dispatch_proto', description: '', schema: {} }],
      execute: async (name) => { calls.push(name); return { ok: true } },
    })
    expect(calls).toEqual(['dispatch_proto'])
    expect(events.filter(e => e.kind === 'tool_call')).toHaveLength(1)
    expect(events.filter(e => e.kind === 'tool_result')).toHaveLength(1)
  })

  it('denies a tool the role may not use and does not execute it', async () => {
    const bus = new EventBus(); const events: AkisEvent[] = []
    bus.subscribe('s1', e => events.push(e))
    const session = initialSession('s1', 'idea')
    const provider = new MockProvider({ script: [
      { toolCalls: [{ name: 'run_tests', args: {} }] },
      { text: 'done' },
    ] })
    const calls: string[] = []
    await runAgentLoop({
      role: 'proto', system: '', laneId: 'main', sessionId: 's1', session, provider, bus,
      tools: [{ name: 'run_tests', description: '', schema: {} }],
      execute: async (name) => { calls.push(name); return { ok: true } },
    })
    expect(calls).toEqual([])
    expect(events.some(e => e.kind === 'tool_result' && e.ok === false)).toBe(true)
  })
})
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: `backend/src/agent/AgentLoop.ts`**
```ts
import type { Role, ToolName, SessionState } from '@akis/shared'
import type { EventBus } from '../events/bus.js'
import type { LlmProvider, ToolSpec, ChatMessage } from './LlmProvider.js'
import { canUseTool, type PermissionCtx } from '../tools/permission.js'

export interface ToolResult { ok: boolean; result?: unknown; error?: string }

export interface AgentLoopArgs {
  role: Role; system: string; laneId: string; sessionId: string; session: SessionState
  provider: LlmProvider; bus: EventBus; tools: ToolSpec[]
  permissionCtx?: PermissionCtx; maxTurns?: number
  execute: (tool: ToolName, args: unknown) => Promise<ToolResult>
}

let clock = 0
const now = () => ++clock  // monotonic, deterministic for tests; runtime injects a real stamper later

export async function runAgentLoop(a: AgentLoopArgs): Promise<void> {
  const messages: ChatMessage[] = []
  const max = a.maxTurns ?? 20
  for (let turn = 0; turn < max; turn++) {
    const res = await a.provider.chat({ role: a.role, system: a.system, messages, tools: a.tools })
    if (res.text) {
      a.bus.emit({ kind: 'text', text: res.text, agent: a.role, laneId: a.laneId, sessionId: a.sessionId, ts: now() })
      messages.push({ role: 'assistant', content: res.text })
    }
    if (!res.toolCalls?.length) return
    for (const call of res.toolCalls) {
      const tool = call.name as ToolName
      a.bus.emit({ kind: 'tool_call', tool, args: call.args, agent: a.role, laneId: a.laneId, sessionId: a.sessionId, ts: now() })
      const verdict = canUseTool(a.role, tool, a.session, a.permissionCtx)
      if (!verdict.ok) {
        a.bus.emit({ kind: 'tool_result', tool, ok: false, result: verdict.reason, agent: a.role, laneId: a.laneId, sessionId: a.sessionId, ts: now() })
        messages.push({ role: 'tool', toolName: tool, content: `PermissionDenied: ${verdict.reason}` })
        continue
      }
      const out = await a.execute(tool, call.args)
      a.bus.emit({ kind: 'tool_result', tool, ok: out.ok, result: out.result ?? out.error, agent: a.role, laneId: a.laneId, sessionId: a.sessionId, ts: now() })
      messages.push({ role: 'tool', toolName: tool, content: JSON.stringify(out) })
    }
  }
}
```

- [ ] **Step 4: Run → PASS (2 tests). Producer≠verifier denial now enforced in-loop.**

- [ ] **Step 5: Commit**
```bash
git add backend/src/agent/AgentLoop.ts backend/test/unit/agent-loop.test.ts
git commit -m "feat(agent): AgentLoop — permission-checked tool dispatch + event emission"
```

---

## Task 8: Skill registry mechanism + thin base prompts

**Files:** Create `backend/src/skills/registry.ts`, `backend/src/prompts/*.base.md`, `backend/src/skills/library/spec/web-app-spec.md`; Test `backend/test/unit/skills.test.ts`.

- [ ] **Step 1: Failing test**
```ts
import { describe, it, expect } from 'vitest'
import { loadSkills, selectSkills, buildSystemPrompt } from '../../src/skills/registry.js'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const libDir = resolve(here, '../../src/skills/library')

describe('skill registry', () => {
  it('loads .md skills with frontmatter and surfaces draft status', () => {
    const reg = loadSkills(libDir)
    const webApp = reg.find(s => s.name === 'web-app-spec')
    expect(webApp).toBeDefined()
    expect(webApp!.appliesToRole).toBe('scribe')
    expect(webApp!.status).toBe('draft')
  })
  it('selects skills by role + trigger', () => {
    const reg = loadSkills(libDir)
    expect(selectSkills(reg, { role: 'scribe', request: 'build me a web app' }).some(s => s.name === 'web-app-spec')).toBe(true)
    expect(selectSkills(reg, { role: 'trace', request: 'build me a web app' }).some(s => s.name === 'web-app-spec')).toBe(false)
  })
  it('builds a system prompt = base + injected skills', () => {
    const reg = loadSkills(libDir)
    const sys = buildSystemPrompt('BASE', selectSkills(reg, { role: 'scribe', request: 'web app' }))
    expect(sys).toContain('BASE'); expect(sys).toContain('web-app-spec')
  })
})
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: `backend/src/skills/library/spec/web-app-spec.md`**
```markdown
---
name: web-app-spec
description: How to write a spec for a small web application MVP
appliesToRole: scribe
triggers: [web app, website, frontend, ui, spa]
status: draft
version: 0.1.0
---

When the user asks for a web application, produce a spec that includes:
problem statement, primary user stories, acceptance criteria (Given/When/Then),
key screens, data persisted, and explicit out-of-scope. If the user named no
tech stack, leave the stack unspecified (Proto chooses HOW).
```

- [ ] **Step 4: `backend/src/skills/registry.ts`**
```ts
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import matter from 'gray-matter'
import type { Role } from '@akis/shared'

export interface Skill {
  name: string; description: string; appliesToRole: Role
  triggers: string[]; status: 'draft' | 'validated'; version: string; body: string
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (p.endsWith('.md')) out.push(p)
  }
  return out
}

export function loadSkills(dir: string): Skill[] {
  return walk(dir).map(p => {
    const { data, content } = matter(readFileSync(p, 'utf8'))
    return {
      name: String(data.name), description: String(data.description ?? ''),
      appliesToRole: data.appliesToRole as Role, triggers: (data.triggers ?? []) as string[],
      status: (data.status ?? 'draft') as Skill['status'], version: String(data.version ?? '0.0.0'),
      body: content.trim(),
    }
  })
}

export interface SelectArgs { role: Role; request: string }
export function selectSkills(reg: Skill[], { role, request }: SelectArgs): Skill[] {
  const q = request.toLowerCase()
  return reg.filter(s => s.appliesToRole === role && s.triggers.some(t => q.includes(t.toLowerCase())))
}
export function buildSystemPrompt(base: string, skills: Skill[]): string {
  if (!skills.length) return base
  const blocks = skills.map(s => `## Skill: ${s.name} (${s.status})\n${s.body}`).join('\n\n')
  return `${base}\n\n# Injected skills\n\n${blocks}`
}
```

- [ ] **Step 5: `backend/src/prompts/scribe.base.md`** (and equally short `orchestrator/proto/trace/critic.base.md`, each ≤8 lines: identity + "use injected skills" + one-line job)
```markdown
You are Scribe. You turn a user's idea into a clear, buildable spec.
Use any injected skills below to match the spec format to the request type.
Output a spec with: problem statement, user stories, acceptance criteria
(Given/When/Then), and out-of-scope. Ask clarifying questions only if essential.
```

- [ ] **Step 6: Run → PASS (3 tests); commit**
```bash
git add backend/src/skills backend/src/prompts backend/test/unit/skills.test.ts
git commit -m "feat(skills): .md+frontmatter registry (load/select/inject) + thin base prompts"
```

---

## Task 9: Sub-agent wrappers — Scribe, Proto, Trace + MockGitHubAdapter

Each wraps ported v1 logic as a role over the loop. Proto uses `MockGitHubAdapter`; Trace is the verifier (only role allowed `run_tests`). Critic was ported in Task 6.

**Files:** Create `backend/src/orchestrator/subagents/{ScribeAgent.ts,ProtoAgent.ts,TraceAgent.ts}`, `backend/src/di/MockGitHubAdapter.ts`; Test `backend/test/unit/subagents.test.ts`.

- [ ] **Step 1: Failing test (MockGitHubAdapter)**
```ts
import { describe, it, expect } from 'vitest'
import { MockGitHubAdapter } from '../../src/di/MockGitHubAdapter.js'

describe('MockGitHubAdapter', () => {
  it('stores pushed files in memory keyed by session, readable back', async () => {
    const gh = new MockGitHubAdapter()
    const url = await gh.createRepo('s1')
    expect(url).toContain('mock')
    await gh.pushFiles('s1', [{ filePath: 'a.ts', content: 'x' }])
    expect(gh.read('s1')).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: `backend/src/di/MockGitHubAdapter.ts`**
```ts
export interface RepoFile { filePath: string; content: string }

export class MockGitHubAdapter {
  private store = new Map<string, RepoFile[]>()
  async createRepo(sessionId: string): Promise<string> {
    this.store.set(sessionId, []); return `https://github.com/mock/${sessionId}`
  }
  async pushFiles(sessionId: string, files: RepoFile[]): Promise<void> {
    this.store.set(sessionId, [...(this.store.get(sessionId) ?? []), ...files])
  }
  read(sessionId: string): RepoFile[] { return [...(this.store.get(sessionId) ?? [])] }
}
```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Write the three sub-agent wrappers.** Each has a `run(input)` that calls the provider with `buildSystemPrompt(base, selectedSkills)` and returns a typed result. Port the prompts from v1 (re-open the source — do not retype from memory):
  - `ScribeAgent`: v1 CLARIFICATION + SPEC_GENERATION prompts → returns `{ spec: SpecArtifact } | { clarify: string[] }`. Honor `mockNeedsClarification`.
  - `ProtoAgent`: v1 `SCAFFOLD_SYSTEM_PROMPT` → returns `{ files: RepoFile[] }`; writes via `MockGitHubAdapter`. Honor `mockProtoFixesOnIterate`.
  - `TraceAgent` (**role `trace` = verifier**): v1 test-gen prompt → generates test files, performs the "run", emits a `verify` event with `testsRun` (= `mockTraceTestCount`, default ≥1) and `passed`. Only this wrapper calls `run_tests`.
  Keep each a thin role over `runAgentLoop` (or a single `provider.chat` for non-tool steps). Match the ported result shapes exactly.

- [ ] **Step 6: Add a Trace verify-event test (append to subagents.test.ts)**
```ts
import { TraceAgent } from '../../src/orchestrator/subagents/TraceAgent.js'
import { MockProvider } from '../../src/agent/mock/MockProvider.js'
import { EventBus } from '../../src/events/bus.js'
import type { AkisEvent } from '@akis/shared'

describe('TraceAgent (verifier)', () => {
  it('emits a verify event with testsRun from the knob', async () => {
    const bus = new EventBus(); const seen: AkisEvent[] = []
    bus.subscribe('s1', e => seen.push(e))
    const provider = new MockProvider({ script: [{ text: 'tests generated' }], knobs: { mockTraceTestCount: 2 } })
    const trace = new TraceAgent({ provider, bus })
    await trace.run({ sessionId: 's1', laneId: 'main', files: [{ filePath: 'a.ts', content: 'x' }] })
    const v = seen.find(e => e.kind === 'verify')
    expect(v && v.kind === 'verify' && v.testsRun).toBe(2)
  })
})
```
Run → PASS (adjust the `TraceAgent` constructor/`run` shape in the test to match Step 5).

- [ ] **Step 7: Commit**
```bash
git add backend/src/orchestrator/subagents backend/src/di/MockGitHubAdapter.ts backend/test/unit/subagents.test.ts
git commit -m "feat(subagents): Scribe/Proto/Trace wrappers + MockGitHubAdapter; Trace emits verify"
```

---

## Task 10: Gate 3 (verifiedReducer) + Gate 4 (pushGate, branded token)

**Files:** Create `backend/src/gates/verifiedReducer.ts`, `backend/src/gates/pushGate.ts`; Test `backend/test/unit/gates.test.ts`.

- [ ] **Step 1: Failing test**
```ts
import { describe, it, expect } from 'vitest'
import { deriveVerified } from '../../src/gates/verifiedReducer.js'
import { mintApprovedPush, pushToGitHub, NotVerifiedError } from '../../src/gates/pushGate.js'
import { initialSession } from '@akis/shared'
import type { AkisEvent } from '@akis/shared'
import { MockGitHubAdapter } from '../../src/di/MockGitHubAdapter.js'

const verify = (over: Partial<AkisEvent>): AkisEvent =>
  ({ kind: 'verify', testsRun: 1, passed: true, agent: 'trace', laneId: 'main', sessionId: 's1', ts: 1, ...over } as AkisEvent)

describe('Gate 3 — verifiedReducer', () => {
  it('verified only when a verifier verify event ran >=1 test and passed', () => {
    expect(deriveVerified([verify({ testsRun: 1, passed: true })])).toBe(true)
    expect(deriveVerified([verify({ testsRun: 0, passed: true })])).toBe(false)
    expect(deriveVerified([verify({ testsRun: 3, passed: false })])).toBe(false)
    expect(deriveVerified([verify({ agent: 'proto' })])).toBe(false)
    expect(deriveVerified([])).toBe(false)
  })
})
describe('Gate 4 — pushGate', () => {
  it('mint throws unless verified, then push requires the token', async () => {
    const unverified = initialSession('s1', 'idea')
    expect(() => mintApprovedPush(unverified)).toThrow(NotVerifiedError)
    const verified = { ...unverified, verified: true }
    const token = mintApprovedPush(verified)
    const gh = new MockGitHubAdapter(); await gh.createRepo('s1')
    const res = await pushToGitHub(token, gh, [{ filePath: 'a.ts', content: 'x' }])
    expect(res.ok).toBe(true); expect(gh.read('s1')).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: `backend/src/gates/verifiedReducer.ts`**
```ts
import type { AkisEvent } from '@akis/shared'
import { VERIFIER_ROLE } from '@akis/shared'

/** Gate 3: verified iff a verifier-tagged verify event ran >=1 test and passed. */
export function deriveVerified(events: AkisEvent[]): boolean {
  return events.some(e => e.kind === 'verify' && e.agent === VERIFIER_ROLE && e.testsRun >= 1 && e.passed === true)
}
```

- [ ] **Step 4: `backend/src/gates/pushGate.ts`**
```ts
import type { SessionState } from '@akis/shared'
import type { MockGitHubAdapter, RepoFile } from '../di/MockGitHubAdapter.js'

export class NotVerifiedError extends Error {
  constructor() { super('Cannot mint ApprovedPush: session is not verified'); this.name = 'NotVerifiedError' }
}

export type ApprovedPush = { readonly __brand: 'ApprovedPush'; readonly sessionId: string }

/** Gate 4: mint requires verified === true (human confirm is the caller). */
export function mintApprovedPush(s: SessionState): ApprovedPush {
  if (!s.verified) throw new NotVerifiedError()
  return { __brand: 'ApprovedPush', sessionId: s.id }
}

export interface PushResult { ok: boolean; url: string }

/** Push is uncallable without the branded token → no push without verified + confirm. */
export async function pushToGitHub(token: ApprovedPush, gh: MockGitHubAdapter, files: RepoFile[]): Promise<PushResult> {
  await gh.pushFiles(token.sessionId, files)
  return { ok: true, url: `https://github.com/mock/${token.sessionId}` }
}
```

- [ ] **Step 5: Run → PASS.**

- [ ] **Step 6: Compile-time proof (add to gates.test.ts)**
```ts
// @ts-expect-error — a bare object is not an ApprovedPush (branded); push without a minted token does not type-check.
const _illegal: import('../../src/gates/pushGate.js').ApprovedPush = { sessionId: 's1' }
```
Run `pnpm -C backend typecheck` and confirm the `@ts-expect-error` is satisfied.

- [ ] **Step 7: Commit**
```bash
git add backend/src/gates backend/test/unit/gates.test.ts
git commit -m "feat(gates): verifiedReducer (Gate 3) + branded pushGate (Gate 4)"
```

---

## Task 11: Orchestrator + parallel dispatch + DI + session store

**Files:** Create `backend/src/orchestrator/parallel.ts`, `backend/src/orchestrator/Orchestrator.ts`, `backend/src/store/SessionStore.ts`, `backend/src/store/MockSessionStore.ts`, `backend/src/di/services.ts`; Test `backend/test/unit/parallel.test.ts`, `backend/test/unit/orchestrator.test.ts`.

- [ ] **Step 1: Parallel test**
```ts
import { describe, it, expect } from 'vitest'
import { runParallel } from '../../src/orchestrator/parallel.js'

describe('runParallel', () => {
  it('runs lanes concurrently and joins results with their laneId', async () => {
    const out = await runParallel([
      { laneId: 'a', run: async () => 1 },
      { laneId: 'b', run: async () => 2 },
    ])
    expect(out).toEqual([{ laneId: 'a', result: 1 }, { laneId: 'b', result: 2 }])
  })
  it('isolates a failing lane to null, others succeed', async () => {
    const out = await runParallel([
      { laneId: 'a', run: async () => { throw new Error('x') } },
      { laneId: 'b', run: async () => 2 },
    ])
    expect(out[0]).toEqual({ laneId: 'a', result: null, error: 'x' })
    expect(out[1]).toEqual({ laneId: 'b', result: 2 })
  })
})
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: `backend/src/orchestrator/parallel.ts`**
```ts
export interface Lane<T> { laneId: string; run: () => Promise<T> }
export interface LaneResult<T> { laneId: string; result: T | null; error?: string }

export async function runParallel<T>(lanes: Lane<T>[]): Promise<LaneResult<T>[]> {
  return Promise.all(lanes.map(async l => {
    try { return { laneId: l.laneId, result: await l.run() } }
    catch (e) { return { laneId: l.laneId, result: null, error: e instanceof Error ? e.message : String(e) } }
  }))
}
```

- [ ] **Step 4: Run → PASS (2 tests).**

- [ ] **Step 5: `backend/src/store/SessionStore.ts` + `MockSessionStore.ts`**
```ts
import type { SessionState } from '@akis/shared'
export interface SessionStore {
  create(s: SessionState): Promise<void>
  get(id: string): Promise<SessionState | undefined>
  update(id: string, patch: Partial<SessionState>, expectedVersion: number): Promise<SessionState>
}
```
```ts
import type { SessionState } from '@akis/shared'
import type { SessionStore } from './SessionStore.js'

export class MockSessionStore implements SessionStore {
  private map = new Map<string, SessionState>()
  async create(s: SessionState) { this.map.set(s.id, { ...s }) }
  async get(id: string) { const s = this.map.get(id); return s ? { ...s } : undefined }
  async update(id: string, patch: Partial<SessionState>, expectedVersion: number) {
    const cur = this.map.get(id)
    if (!cur) throw new Error(`session ${id} not found`)
    if (cur.version !== expectedVersion) throw new Error(`version conflict: ${cur.version} !== ${expectedVersion}`)
    const next = { ...cur, ...patch, version: cur.version + 1 }
    this.map.set(id, next); return { ...next }
  }
}
```

- [ ] **Step 6: `backend/src/di/services.ts`**
```ts
import type { LlmProvider } from '../agent/LlmProvider.js'
import type { SessionStore } from '../store/SessionStore.js'
import { EventBus } from '../events/bus.js'
import { MockGitHubAdapter } from './MockGitHubAdapter.js'
import { DeterministicValidator } from '../validator/DeterministicValidator.js'
import { CriticAgent } from '../orchestrator/subagents/critic/CriticAgent.js'
import { loadSkills, type Skill } from '../skills/registry.js'

export interface OrchestratorServices {
  provider: LlmProvider; store: SessionStore; bus: EventBus; github: MockGitHubAdapter
  validator: DeterministicValidator; critic: CriticAgent; skills: Skill[]
}

export function buildServices(opts: { provider: LlmProvider; store: SessionStore; skillsDir: string }): OrchestratorServices {
  const generateText = async (system: string, user: string) =>
    (await opts.provider.chat({ role: 'critic', system, messages: [{ role: 'user', content: user }], tools: [] })).text ?? ''
  return {
    provider: opts.provider, store: opts.store, bus: new EventBus(),
    github: new MockGitHubAdapter(), validator: new DeterministicValidator(),
    critic: new CriticAgent({ generateText }, { approvalThreshold: 75 }),
    skills: loadSkills(opts.skillsDir),
  }
}
```

- [ ] **Step 7: Orchestrator test (happy-path flow on mock)**
```ts
import { describe, it, expect } from 'vitest'
import { Orchestrator } from '../../src/orchestrator/Orchestrator.js'
import { MockProvider } from '../../src/agent/mock/MockProvider.js'
import { MockSessionStore } from '../../src/store/MockSessionStore.js'
import { buildServices } from '../../src/di/services.js'
import { fileURLToPath } from 'node:url'; import { dirname, resolve } from 'node:path'

const skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/skills/library')

describe('Orchestrator (happy path on mock)', () => {
  it('runs scribe→critic(spec)→[approve]→proto→validator→critic(code)→trace→[confirm]→done verified', async () => {
    const provider = new MockProvider({ script: [/* scripted dispatch sequence */], knobs: { mockCriticScore: 90, mockTraceTestCount: 2 } })
    const services = buildServices({ provider, store: new MockSessionStore(), skillsDir })
    const orch = new Orchestrator(services)
    const s = await orch.start({ idea: 'build a todo web app' })
    expect((await services.store.get(s.id))!.status).toBe('awaiting_spec_approval')
    await orch.approve(s.id)
    await orch.runToVerification(s.id)
    const afterTrace = (await services.store.get(s.id))!
    expect(afterTrace.verified).toBe(true)
    expect(afterTrace.status).toBe('awaiting_push_confirm')
    const done = await orch.confirmPush(s.id)
    expect(done.status).toBe('done'); expect(done.verified).toBe(true)
  })
})
```

- [ ] **Step 8: Run → FAIL.**

- [ ] **Step 9: `backend/src/orchestrator/Orchestrator.ts`** — implement with these methods (match the test names exactly):
  - `start({ idea })`: create session → run Scribe (skill-selected) → run Critic spec-review → set `spec`, emit `gate{spec_approval, awaiting}`, status `awaiting_spec_approval`. Returns the session.
  - `approve(id)`: set `approvedSpec = spec`, status `building`, emit `gate{spec_approval, satisfied}`.
  - `runToVerification(id)`: dispatch Proto (now permitted by Gate 1) → `validator.validate` → Critic code-review → dispatch Trace (verifier; emits `verify`) → set `verified = deriveVerified(bus.recent(id))` → if verified, status `awaiting_push_confirm`, emit `gate{push_confirm, awaiting}`. If Critic/Trace fail within budget, re-dispatch Proto with feedback (the orchestrator's choice — agentic, no fixed loop), capped.
  - `confirmPush(id)`: `mintApprovedPush(session)` (throws `NotVerifiedError` if not verified) → `pushToGitHub(token, github, files)` (set `permissionCtx.hasApprovedPushToken` only here) → status `done`, emit `done{verified:true}`.
  Keep the body small; lean on sub-agent wrappers (Task 9) + gates (Task 10).

- [ ] **Step 10: Run → PASS.** Fill the scripted `MockProvider` sequence so each dispatch returns the expected sub-agent output.

- [ ] **Step 11: Commit**
```bash
git add backend/src/orchestrator backend/src/store backend/src/di/services.ts backend/test/unit/parallel.test.ts backend/test/unit/orchestrator.test.ts
git commit -m "feat(orchestrator): conversational core + parallel dispatch + DI + session store"
```

---

## Task 12: The contract test — the 4-gate lock (Scenarios A–F)

The regression tripwire. Asserts the 4 gates **structurally**, regardless of agent flow.

**Files:** Create `backend/test/contract/agentic-gates.contract.test.ts`.

- [ ] **Step 1: Write the contract test**
```ts
import { describe, it, expect } from 'vitest'
import { Orchestrator } from '../../src/orchestrator/Orchestrator.js'
import { MockProvider } from '../../src/agent/mock/MockProvider.js'
import { MockSessionStore } from '../../src/store/MockSessionStore.js'
import { buildServices } from '../../src/di/services.js'
import { canUseTool } from '../../src/tools/permission.js'
import { mintApprovedPush, NotVerifiedError } from '../../src/gates/pushGate.js'
import { initialSession } from '@akis/shared'
import { fileURLToPath } from 'node:url'; import { dirname, resolve } from 'node:path'

const skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/skills/library')
const make = (knobs = {}) => {
  const provider = new MockProvider({ script: [/* full happy sequence */], knobs: { mockCriticScore: 90, mockTraceTestCount: 2, ...knobs } })
  const services = buildServices({ provider, store: new MockSessionStore(), skillsDir })
  return { services, orch: new Orchestrator(services) }
}

describe('CONTRACT: 4 structural gates', () => {
  it('A — happy path reaches done verified; ApprovedPush only after confirm', async () => {
    const { orch, services } = make()
    const s = await orch.start({ idea: 'todo web app' })
    await orch.approve(s.id); await orch.runToVerification(s.id)
    const done = await orch.confirmPush(s.id)
    expect(done.status).toBe('done'); expect(done.verified).toBe(true)
    const events = services.bus.recent(s.id)
    expect(events.some(e => e.kind === 'gate' && e.gate === 'spec_approval' && e.state === 'satisfied')).toBe(true)
    expect(events.some(e => e.kind === 'gate' && e.gate === 'push_confirm')).toBe(true)
  })
  it('B — Gate 1: dispatch_proto denied before spec approval', () => {
    const base = initialSession('s1', 'idea')
    expect(canUseTool('orchestrator', 'dispatch_proto', base).ok).toBe(false)
    expect(canUseTool('orchestrator', 'dispatch_proto', { ...base, approvedSpec: { title: 't', body: 'b' } }).ok).toBe(true)
  })
  it('C — Gate 2: only the verifier may run_tests', () => {
    const base = initialSession('s1', 'idea')
    expect(canUseTool('trace', 'run_tests', base).ok).toBe(true)
    for (const r of ['orchestrator', 'proto', 'scribe', 'critic'] as const)
      expect(canUseTool(r, 'run_tests', base).ok).toBe(false)
  })
  it('D — Gate 3: vacuous green (0 tests) never verifies, cannot mint, never done', async () => {
    const { orch, services } = make({ mockTraceTestCount: 0 })
    const s = await orch.start({ idea: 'todo' }); await orch.approve(s.id); await orch.runToVerification(s.id)
    const st = (await services.store.get(s.id))!
    expect(st.verified).toBe(false)
    expect(() => mintApprovedPush(st)).toThrow(NotVerifiedError)
    await expect(orch.confirmPush(s.id)).rejects.toBeInstanceOf(NotVerifiedError)
    expect((await services.store.get(s.id))!.status).not.toBe('done')
  })
  it('E — Gate 4: minting needs verified', () => {
    const verified = { ...initialSession('s1', 'idea'), verified: true }
    expect(() => mintApprovedPush(verified)).not.toThrow()
    expect(() => mintApprovedPush({ ...verified, verified: false })).toThrow(NotVerifiedError)
  })
  it('F — liveness: events are agent+lane tagged; verify is verifier-tagged', async () => {
    const { orch, services } = make()
    const s = await orch.start({ idea: 'todo' }); await orch.approve(s.id); await orch.runToVerification(s.id)
    const events = services.bus.recent(s.id)
    expect(events.every(e => typeof e.agent === 'string' && typeof e.laneId === 'string')).toBe(true)
    expect(events.some(e => e.kind === 'verify' && e.agent === 'trace')).toBe(true)
  })
})
```

- [ ] **Step 2: Run** (`pnpm -C backend test agentic-gates`). B/C/E pass immediately (pure). Iterate the `MockProvider` script + orchestrator until A/D/F pass.

- [ ] **Step 3: Full suite → PASS** (`pnpm -C backend test`).

- [ ] **Step 4: Commit**
```bash
git add backend/test/contract/agentic-gates.contract.test.ts
git commit -m "test(contract): 4-gate lock (Scenarios A-F) green on mock"
```

---

## Task 13: Skill library (research workflow) + smoke + DoD

**Files:** Create `backend/src/skills/library/**/*.md`, `backend/scripts/smoke-mock-run.ts`.

- [ ] **Step 1: Author the draft skill library.** Run a research workflow (parallel agents per category) to author `.md` skills under `backend/src/skills/library/`, every file with frontmatter `status: draft`. Minimum categories:
  - `spec/`: web-app-spec (exists), rest-api-spec, data-pipeline-spec, cli-tool-spec, prd-business-requirements
  - `code/`: react-spa-scaffold, node-service-scaffold, cli-tool-scaffold
  - `test/`: vitest-unit-suite, api-contract-tests
  - `review/`: security-review, a11y-review
  Each skill: `name`, `description`, `appliesToRole`, `triggers`, `status: draft`, `version`, focused instruction body. A critic agent gap-scans for missing categories/contradictions. **All `status: draft`** (unvalidated on mock; real-AI tuning is the next sub-project).

- [ ] **Step 2: Registry-loads-all test (append to skills.test.ts)**
```ts
it('every library skill is status:draft and has required frontmatter', () => {
  const reg = loadSkills(libDir)
  expect(reg.length).toBeGreaterThanOrEqual(10)
  for (const s of reg) {
    expect(s.status).toBe('draft')
    expect(s.name).toBeTruthy(); expect(s.appliesToRole).toBeTruthy()
    expect(Array.isArray(s.triggers)).toBe(true)
  }
})
```
Run → PASS.

- [ ] **Step 3: `backend/scripts/smoke-mock-run.ts`**
```ts
import { Orchestrator } from '../src/orchestrator/Orchestrator.js'
import { MockProvider } from '../src/agent/mock/MockProvider.js'
import { MockSessionStore } from '../src/store/MockSessionStore.js'
import { buildServices } from '../src/di/services.js'
import { fileURLToPath } from 'node:url'; import { dirname, resolve } from 'node:path'

const skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src/skills/library')

async function run(label: string, knobs: Record<string, unknown>) {
  const provider = new MockProvider({ script: [/* same as contract happy script */], knobs: { mockCriticScore: 90, mockTraceTestCount: 2, ...knobs } })
  const services = buildServices({ provider, store: new MockSessionStore(), skillsDir })
  const orch = new Orchestrator(services)
  const s = await orch.start({ idea: 'build a todo web app' })
  services.bus.subscribe(s.id, e => console.log(`  [${e.laneId}] ${e.agent} · ${e.kind}${'text' in e ? ': ' + e.text : ''}`))
  await orch.approve(s.id); await orch.runToVerification(s.id)
  try { const done = await orch.confirmPush(s.id); console.log(`${label}: ${done.status} verified=${done.verified}\n`) }
  catch (e) { console.log(`${label}: blocked — ${(e as Error).name} (correct: vacuous green ⚠️)\n`) }
}

await run('HAPPY', {})
await run('VACUOUS-GREEN', { mockTraceTestCount: 0 })
```

- [ ] **Step 4: Run the smoke** (`pnpm -C backend smoke`). Expect: HAPPY → `done verified=true`; VACUOUS-GREEN → "blocked — NotVerifiedError".

- [ ] **Step 5: Definition of Done** — Run `pnpm -C backend typecheck && pnpm -C backend test`. Expect: tsc strict clean; all unit + contract tests pass. Confirm structurally-impossible behaviors hold (B/C/D/E).

- [ ] **Step 6: Commit**
```bash
git add backend/src/skills/library backend/scripts/smoke-mock-run.ts backend/test/unit/skills.test.ts
git commit -m "feat(skills): researched draft skill library + smoke run; sub-project #1 DoD green"
```

---

## Self-review notes (carried into execution)

- **Survey corrections baked in (Task 6):** `ValidationFile` is `{path,content,language}` (not `{filePath,content}`); `CriticReviewInput` uses `artifactType` (not `reviewType`); `CriticResult` is `{type,data?,error?}`. The executor re-opens v1 source rather than retyping.
- **Method-name consistency:** Orchestrator exposes `start` / `approve` / `runToVerification` / `confirmPush` — used identically in Task 11 + Task 12 + Task 13.
- **Gate→test mapping:** Gate 1 → permission.test + contract B; Gate 2 → permission.test + agent-loop.test + contract C; Gate 3 → gates.test (deriveVerified) + contract D; Gate 4 → gates.test (pushGate) + contract E. All four covered.
- **`now()` determinism:** AgentLoop uses a monotonic counter so tests are stable; runtime swaps a real timestamper later (noted in Task 7).
