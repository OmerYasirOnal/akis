# SharedContext — one typed context every agent reads (sub-project 3)

**Goal:** Give every agent a single, **typed**, read-only view of the session's
shared knowledge, and have AKIS (the orchestrator) dispatch each agent with that
read view — without an untyped blob and without ever handing a dispatched agent a
gate capability.

**Maps to:** F2-AC16 (shared context environment), F2-AC17 (AKIS dispatch with
context). Builds on the existing single sources of truth (SessionState + the
AkisEvent log) and the future RAG layer via a `KnowledgePort` seam.

**Invariants (must hold):** the 4 structural gates stay structural; the gate
contract test (A–F) stays GREEN; the only write path into shared state remains
typed events / typed returns (no hidden mutation); a dispatched agent never
reaches a gate capability it isn't entitled to (F2-AC17); tsc strict clean.

---

## The v1 mistake this avoids

AKIS v1 used an untyped `intermediateState: Record<string, unknown>` bag that any
stage could write anything into — unsound, untyped cross-stage coupling. Here the
shared context is **assembled, read-only, and typed**; the scratchpad is
**derived from the typed event log**, not separately mutated. So there is exactly
one write path (emit a typed event / return a typed value), and the context is a
pure projection of it.

---

## Components

### 1. Data types (`shared/src/context.ts` — consumable by FE later)
```ts
export interface KnowledgeChunk {
  id: string
  text: string
  source: string          // file path / session id / url
  score: number           // retrieval score (0..1)
}

export type GateState = 'awaiting' | 'satisfied' | 'rejected'

/** Typed cross-agent scratchpad — DERIVED from the event log, never free-form.
 *  No `Record<string, unknown>`: every field is named and typed. */
export interface Scratchpad {
  gates: { specApproval?: GateState; pushConfirm?: GateState }
  verification?: { testsRun: number; passed: boolean }
  previewUrl?: string
  notes: string[]         // orchestrator narration (`text` events), capped
  errors: string[]        // `error` events + failed tool_results, capped
}

/** The single typed, read-only context every agent reads. A pure projection of
 *  SessionState + the AkisEvent log + retrieved knowledge — no setters. */
export interface SharedContext {
  readonly session: Readonly<SessionState>
  readonly events: readonly AkisEvent[]
  readonly scratchpad: Readonly<Scratchpad>
  readonly knowledge: readonly KnowledgeChunk[]
}
```

### 2. Scratchpad fold (`backend/src/context/scratchpad.ts`)
`foldScratchpad(events: readonly AkisEvent[]): Scratchpad` — a pure reducer over
the event log:
- `gate` events → `gates.specApproval` / `gates.pushConfirm` (last state wins).
- `verify` event → `verification = { testsRun, passed }`.
- `preview` event → `previewUrl`.
- `text` events → `notes` (capped at N, most recent).
- `error` events and `tool_result` with `ok:false` → `errors` (capped).
Deterministic, no I/O. This is the proof that the scratchpad has no write path
other than the event log.

### 3. KnowledgePort seam (`backend/src/knowledge/KnowledgePort.ts`)
```ts
export interface RetrieveQuery { query: string; sessionId: string; limit?: number }
export interface KnowledgePort { retrieve(q: RetrieveQuery): Promise<KnowledgeChunk[]> }
/** Default until the Auto-RAG sub-project (4) lands: grounds nothing. */
export class NullKnowledgePort implements KnowledgePort {
  async retrieve(): Promise<KnowledgeChunk[]> { return [] }
}
```
This is the frozen contract coordination-notes asked for; RAG (sub-project 4)
provides the real implementation behind the same interface.

### 4. Assembly (`backend/src/context/assemble.ts`)
```ts
export async function assembleSharedContext(
  sessionId: string,
  deps: { store: SessionStore; bus: EventBus; knowledge: KnowledgePort },
  opts: { query: string; knowledgeLimit?: number },
): Promise<SharedContext>
```
- `session = await store.get(sessionId)` (throws "not found" if absent).
- `events = bus.recent(sessionId)`.
- `scratchpad = foldScratchpad(events)`.
- `knowledge = await knowledge.retrieve({ query, sessionId, limit })`.
- returns a **deep-frozen** `SharedContext` (read-only at runtime too).

### 5. DI wiring (`backend/src/di/services.ts`)
Add `knowledge: KnowledgePort` to `OrchestratorServices` (default
`NullKnowledgePort`, injectable). No agent gains a capability — it's a data port.

### 6. AKIS dispatch with a read view (F2-AC17)
The orchestrator assembles a `SharedContext` before each producer dispatch and
passes it as an **optional** `ctx?: SharedContext` on the agent input (optional =
existing tests/back-compat keep working; the orchestrator always provides it):
- `ScribeAgent`: `ctx` query = the idea; the prompt appends a knowledge slice +
  relevant scratchpad notes when present.
- `ProtoAgent`: `ctx` query = spec title/body; prompt appends knowledge +
  prior errors/feedback context.
The read view is **pure data** — it carries no verifier, minter, runner, or store
handle, so a dispatched producer structurally cannot reach a gate capability
(F2-AC17). This is enforced both by the existing branded-capability design and by
a test asserting the context object exposes no functions.

---

## Data flow
```
Orchestrator.start / runToVerification
  └─ ctx = assembleSharedContext(id, {store, bus, knowledge}, {query})
       ├─ store.get(id)            -> session (SessionState)
       ├─ bus.recent(id)           -> events (AkisEvent[])
       ├─ foldScratchpad(events)   -> typed scratchpad
       └─ knowledge.retrieve(...)  -> knowledge chunks (NullKnowledgePort -> [])
  └─ scribe.run({ ..., ctx }) / proto.run({ ..., ctx })   // read view only
```

## Testing (TDD — failing test first)
1. **`scratchpad.test.ts`:** fold an event log → correct typed scratchpad (gates,
   verification, previewUrl, notes/errors caps); empty log → empty scratchpad;
   the ONLY way a field changes is via a corresponding event (write-path proof).
2. **`knowledge-port.test.ts`:** `NullKnowledgePort.retrieve` → `[]`.
3. **`assemble.test.ts`:** returns session+events+scratchpad+knowledge; calls
   `knowledge.retrieve` with the query (spy stub returns chunks → appear in
   context); unknown session → throws "not found"; the returned object is
   deep-frozen (mutation throws) and exposes **no functions** (F2-AC17 read-only).
4. **`shared-context.dispatch.test.ts`:** the orchestrator calls
   `knowledge.retrieve` during a run (spy), and Scribe/Proto receive a `ctx`
   whose shape matches `SharedContext` and contains no capability (no verifier/
   minter/function). A stub KnowledgePort returning a chunk shows the chunk
   reaching the agent prompt input.
5. **Invariant guard:** gate contract A–F stays green; `tsc --noEmit` clean; full
   suite green; the agents still work with `ctx` absent (back-compat).

## Out of scope (later sub-projects)
- The real RAG implementation behind `KnowledgePort` (sub-project 4 / F1-AC*).
- Threading `ctx` into Critic/Trace prompts (producers Scribe/Proto cover the
  AC; Trace's context is the files under test). Follow-up if needed.
- Persisting the scratchpad (it is always re-derivable from the event log).
- Skill-slice selection logic (uses the existing skills registry as-is).
