# Live Visibility — Orchestrator HTTP routes + Resumable SSE (sub-project 2)

**Goal:** Make the orchestrator reachable and observable over HTTP. Add command
routes (start/approve/run/confirm), a read route (session state), and a
**resumable** SSE event stream so a live UI never loses or duplicates steps
across refresh/reconnect.

**Maps to:** CF1 (orchestrator HTTP routes + SSE endpoint), CF5 / **F2-AC12**
(resumable live stream: per-session monotonic `seq` + server buffer +
`Last-Event-ID` resume).

**Invariants (must hold):** the 4 structural gates stay structural; the gate
contract test (A–F) stays GREEN; no API key in the repo; produce/verify
separation preserved; no verification-bypass. The HTTP layer is a thin transport
over the existing `Orchestrator` + `EventBus` + `SessionStore` — it adds no new
authority and cannot mutate gate-bearing state.

---

## Why resumable (the pitfall this closes)

SSE token/event streaming is the proven live-UI pattern, but the **client
consumption cursor ≠ the server emission cursor**. Without a per-event monotonic
id + a server buffer + `Last-Event-ID` resume, an agent UI **loses or duplicates
steps on refresh/reconnect** (events emitted while disconnected are missed, or
the whole stream is replayed and dupes). The fix: every event carries a
per-session monotonic `seq`; the server keeps a bounded buffer; on reconnect the
browser's `EventSource` sends `Last-Event-ID: <lastSeq>` and the server replays
only `seq > lastSeq`. If the requested cursor is older than the buffer
(overflow), the server sends a `reset` control event and the client re-syncs
from `GET /sessions/:id`.

Today: events carry a global counter `ts`, **not** a per-session resumable `seq`;
the buffer is capped at 200 with no overflow signal; there is no SSE endpoint
(`api/server.ts` exposes only `/health` + `/api/providers`).

---

## Components

### 1. Per-session monotonic `seq` in `EventBus` (`backend/src/events/bus.ts`)
`seq` is a **transport concern assigned by the bus at emit time** — it is NOT
added to the `AkisEvent` shape (that would force every emit site to supply it and
pollute the domain event). The buffer stores `{ seq, event }`.

- `emit(e)` — unchanged signature; assigns the next per-session `seq` (1,2,3…)
  internally, buffers `{seq, event}` (cap 200, evict oldest), notifies listeners
  with `(event, seq)`.
- `subscribe(sessionId, fn)` — listener signature **widened** to
  `(event: AkisEvent, seq: number) => void`. Existing one-arg callbacks
  (`e => …`) remain assignable (fewer params is allowed), so no caller breaks.
- `recent(sessionId): AkisEvent[]` — **unchanged** (back-compat for existing
  consumers, e.g. the gate contract test).
- `replaySince(sessionId, afterSeq): { dropped: boolean; events: Array<{seq, event}> }`
  — returns buffered events with `seq > afterSeq`. `dropped` is `true` when
  `afterSeq` precedes the oldest buffered `seq` (i.e. `afterSeq + 1 < oldestSeq`),
  meaning some events were evicted and the client must re-sync. `afterSeq = 0`
  means "from the beginning" and is only `dropped` if eviction has occurred.
- `head(sessionId): number` — latest assigned `seq` (0 if none).

### 2. SSE framing helpers (`backend/src/api/sse.ts`)
Pure string builders (unit-tested for exact bytes):
- `sseEvent(seq, event): string` → `id: <seq>\ndata: <JSON.stringify(event)>\n\n`
- `sseControl(name, data): string` → `event: <name>\ndata: <JSON>\n\n`
  (used for `reset` and an initial `hello`/heartbeat comment).
- `sseComment(text): string` → `: <text>\n\n` (keep-alive ping).

### 3. Orchestrator HTTP routes (`backend/src/api/sessions.routes.ts`)
Registered on the shared Fastify app with an injected `{ orchestrator, services }`.

| Method + path | Action | Success | Errors |
|---|---|---|---|
| `POST /sessions` `{idea}` | `orchestrator.start` | `201 {id,status,version}` | `400` empty idea |
| `GET /sessions/:id` | `services.store.get` | `200 SessionState` | `404` not found |
| `POST /sessions/:id/approve` | `orchestrator.approve` | `200 SessionState` | gate/precondition → `409 {error,code}`; `404` |
| `POST /sessions/:id/run` | `orchestrator.runToVerification` | `200 SessionState` | `409`; `404` |
| `POST /sessions/:id/confirm` | `orchestrator.confirmPush` | `200 SessionState` | `409`; `404` |
| `GET /sessions/:id/events` | resumable SSE (below) | `200 text/event-stream` | `404` if unknown id and no buffer |

**Error mapping** (a single `mapError` helper): `SpecNotApprovedError`,
`NotVerifiedError`, `WrongStatusError`, `AlreadyPushedError`, `CriticFailedError`,
`CodeMismatchError` → **409** with `{ error: message, code: name }`; "not found"
→ **404**; everything else → **500** (message only, never internals/keys).
Mapping gate failures to 4xx is observability, NOT a bypass — the gate already
refused; the route only reports it.

**SSE handler flow** (`GET /sessions/:id/events`):
1. Set headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`,
   `Connection: keep-alive`, `X-Accel-Buffering: no`. Use `reply.raw` (Node
   stream) and **do not** let Fastify serialize/close it; disable the route
   timeout.
2. Read cursor: `Last-Event-ID` header, else `?lastEventId` query, else `0`.
3. `const { dropped, events } = services.bus.replaySince(id, cursor)`.
   - If `dropped`, write `sseControl('reset', { head: bus.head(id) })` first — the
     client should `GET /sessions/:id` for full state and continue from `head`.
4. Write a replay frame per buffered event (`id:` = its `seq`).
5. `subscribe(id, (event, seq) => write(sseEvent(seq, event)))` for live frames.
   Guard against the replay/live race: capture `head` BEFORE subscribing is
   wrong (could drop the event emitted between replay and subscribe); instead
   subscribe FIRST, buffer live frames, then replay `replaySince(cursor)`, then
   flush live frames whose `seq` > last replayed `seq` (dedupe by seq). Simpler &
   race-free: subscribe first into a `pending` array; run replay; write replay;
   then write any `pending` with `seq` greater than the max replayed seq; then
   switch to direct write. (Implementation note carried into the plan.)
6. Heartbeat: every 15s write `sseComment('ping')` so proxies don't time out.
7. On `reply.raw.on('close', …)`: unsubscribe, clear heartbeat. Never throw.

### 4. Server wiring (`backend/src/api/server.ts`)
`buildServer` builds **one** shared `OrchestratorServices` (single store + single
bus) and **one** `Orchestrator`, then registers provider + session routes against
them. Both are injectable for tests:

```ts
export interface ServerDeps {
  keyStore: KeyStore
  env?: Record<string, string | undefined>
  // Test/host injection. If omitted, built from a MockSessionStore + createProvider
  // (fail-closed; mock only under NODE_ENV=test) + the skills library dir.
  services?: OrchestratorServices
  orchestrator?: Orchestrator
  skillsDir?: string
}
```

Default build path: `buildServices({ store: new MockSessionStore(), skillsDir,
keyStore })` → provider resolves via `createProvider` (env/KeyStore; Claude by
default; mock under test). `testRunner` is injectable through `services` so a
server test can drive a real ≥1-test pass to exercise verify→confirm.

---

## Data flow (happy path + reconnect)

```
POST /sessions {idea}
  └─ Orchestrator.start → emits session/text/agent_*/tool_*/gate events
       └─ EventBus buffers each as {seq:1..N, event}

GET /sessions/:id/events            (EventSource, no Last-Event-ID)
  └─ replaySince(0) → all buffered (seq 1..N) written as id:1..N
  └─ subscribe → live frames id:N+1, N+2, …

POST /sessions/:id/approve | run | confirm  → more events → live frames

(refresh / network drop)
GET /sessions/:id/events            (EventSource auto-sends Last-Event-ID: K)
  └─ replaySince(K) → only seq>K  → NO loss, NO dup
  └─ if K < oldestBufferedSeq-1 → reset control → client GET /sessions/:id
```

---

## Testing (TDD — write the failing test first)

1. **`bus-seq.test.ts` (unit):** emit assigns `seq` 1,2,3 per session; sessions
   isolated; `replaySince(afterSeq)` returns the correct tail; `head()`; after
   exceeding the cap, `replaySince(0).dropped === true` and only the last `cap`
   remain; subscribe receives `(event, seq)`.
2. **`sse.test.ts` (unit):** `sseEvent` exact framing (`id:`/`data:`/blank line);
   `sseControl('reset', …)`; `sseComment`.
3. **`sessions.routes.test.ts` (route, `app.inject`):** POST creates (201, id);
   GET returns state / 404; approve/run/confirm happy path (with an injected
   passing `testRunner`) reaches `done`; **confirm before run → 409** and
   **run before approve → 409** (gate contract NOT bypassed via HTTP);
   bad/empty idea → 400.
4. **`sse-resume.test.ts` (integration, real `app.listen` + `fetch`):**
   - Start a session (events buffered). Connect SSE with no `Last-Event-ID` →
     receive all buffered frames (assert ids contiguous from 1).
   - Drive `approve`/`run` → read the new live frames.
   - Abort the stream; reconnect with `Last-Event-ID = lastSeenSeq` → receive
     ONLY `seq > lastSeen` (no loss, no duplicate) — **F2-AC12**.
   - Force overflow (emit > cap events) then reconnect with a stale id → first
     frame is `event: reset`.
   Read frames from the response `ReadableStream`, parse `id:`/`data:`, abort
   after the expected count (bounded by a timeout so the test can't hang).
5. **Invariant guard:** `agentic-gates.contract.test.ts` (A–F) stays green;
   `tsc --noEmit` clean; full suite green.

---

## Error handling summary
- Gate/precondition failures → typed **409 `{error, code}`** (report, not bypass).
- Unknown session → **404**. Malformed body → **400**. Unexpected → **500**
  (message only; no stack/internals; never a key).
- SSE: client disconnect → unsubscribe + clear heartbeat + end; handler never
  throws into the loop; a slow/closed socket can't wedge the bus.

## Out of scope (later sub-projects)
- **Full drain-based SSE flow control.** The handler bounds per-connection memory
  by dropping a stalled client once its unflushed buffer exceeds
  `MAX_SSE_BUFFER_BYTES` (OOM guard), and skips the heartbeat while the socket
  needs drain. Proper `'drain'`-event pause/resume that keeps a slow-but-alive
  client connected is deferred to hardening (F2-AC13/14 territory).
- Event-log **persistence across process restart** (buffer is in-memory; a
  restart loses history — noted, deferred to a persistence sub-project).
- Auth / multi-tenant on routes (single-user local-first MVP).
- OpenTelemetry spans/metrics (F2-AC15) — separate.
- SharedContext assembly (sub-project 3) and Auto-RAG (sub-project 4).
- Bounded-loop/least-privilege ACs (F2-AC13/14) — separate hardening.
```
