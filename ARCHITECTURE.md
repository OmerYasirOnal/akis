# AKIS — Architecture (2026-06-03)

> The real, shipped architecture of the AKIS MVP — accurate, not aspirational. AKIS is a self-hostable agentic build studio whose thesis is **quality trust**: AI agents do the work, but nothing is marked *verified* or pushed until it passes **4 inviolable structural gates** with a human in the loop. This doc names the spine and where each piece lives; for current product state see `README.md`, for what's left see `docs/NEXT.md`, for the trust boundary see `THREAT-MODEL.md`.

pnpm workspace: `backend/` (Fastify + TS) · `frontend/` (React 19 + Vite + Tailwind v4) · `shared/` (`@akis/shared` types + brands). The backend test suite (`pnpm -C backend test` = `tsc --noEmit` strict + vitest) is the gate.

## 1. The orchestrator spine

The flow is **agentic, but bounded** — a main orchestrator (`backend/src/orchestrator/Orchestrator.ts`) dispatches sub-agents; the invariant is the 4 gates, **not** an FSM transition table.

```
idea → Scribe (spec) → [GATE 1: human approval] → Proto (code)
     → Trace (real test → verify) → Critic (review) → [GATE 4: human push-confirm] → push
```

- **Scribe** (`orchestrator/subagents/ScribeAgent.ts`) — idea → typed `SpecArtifact`. Calls the injected LLM. When RAG is on it composes the spec through the existing bounded tool-loop (`agent/tools/toolLoop.ts`) with **only** the read-only `retrieve_knowledge` tool in scope — zero gate authority — so it can pull grounding on demand (each use surfaces as a `tool_call`/`tool_result`); RAG-off is byte-identical single-shot. **Scribe only** today — Proto and Critic stay single-shot.
- **Proto** (`subagents/ProtoAgent.ts`) — approved spec → `RepoFile[]`. **Requires an `ApprovedSpec` token** (Gate 1), so it cannot run before approval.
- **Trace** (`subagents/TraceAgent.ts`) — the **verifier** role; runs a real test runner (Playwright/Cucumber) when `AKIS_REAL_TESTS` is on (`backend/src/verify/*`, `bdd/*`).
- **Critic** (`subagents/critic/CriticAgent.ts`) — spec + code review verdict (surfaced as a read-only status card).
- Sub-agents read a single typed, read-only **SharedContext** (`backend/src/context/assemble.ts`); they hold **no** gate capability. Lanes are `laneId` labels on the event stream (`main`/`verify`), not a separate parallel-lanes module.

## 2. The 4 gates + branded tokens (the moat)

Defined in `backend/src/gates/` (`specGate.ts`, `pushGate.ts`) and `@akis/shared`. Each gate is enforced **structurally**, not by convention:

1. **Spec-approval** — code-write is denied until a human approves the spec (`ApprovedSpec` token, mintable only from an approval bound to the reviewed spec).
2. **Producer ≠ verifier** — only the `trace` (verifier) role is handed a `Verifier` capability in DI; producers get none.
3. **Verified = a real test** — a `VerifyToken` latches only on a verifier run with ≥1 executed + passing test (fail-closed); the token carries a runner-computed **digest** of the tested files, and the push gate requires pushed-code = verified-code.
4. **Push gate** — a GitHub push needs an `ApprovedPush` token, mintable only when verified **and** human-confirmed.

Tokens (`VerifyToken`, `ApprovalToken`, `ApprovedPush`, `TestRunResult`) are nominal **`unique symbol` brands** — cannot be written as a literal or satisfied with `as T`; the minting capabilities are module-private (a forging import is a compile error). The store's generic `update` patch type-excludes the gate fields. Proven by `@ts-expect-error` tripwires + a contract test driving the **real** orchestrator adversarially (`backend/test/contract/agentic-gates.contract.test.ts`).

**Honest boundary:** the gates give **integrity, not confidentiality** — in one OS process a first-party module can still reach a handed capability. There is **no sandbox isolation** (`LocalDirectSandbox` in `backend/src/exec/Sandbox.ts` is env-scrubbing + process-group kill, not a boundary). See `THREAT-MODEL.md`.

## 3. The provider seam

`backend/src/agent/` — one `LlmProvider` interface over **4 real providers**: Anthropic (default), OpenAI, OpenRouter (OpenAI-compatible), Gemini. `providers/catalog.ts` is the single source of model IDs; `providers/createProvider.ts` resolves provider by arg → env → key-prefix and **fails closed outside `NODE_ENV=test`** (a misconfigured key never silently runs the mock as "verified"). `providers/mock/MockProvider.ts` is the deterministic keyless default for tests + offline runs.

- **Keys:** encrypted `KeyStore` (`backend/src/keys/KeyStore.ts` + `crypto.ts`); managed via `GET/PUT/DELETE /api/providers`.
- **Tools:** a bounded, provider-agnostic tool-loop (`agent/tools/toolLoop.ts`) + a `ToolRegistry` that holds **no** gate capability. Wired into the **advisory/ASK** agent (`agent/dynamic/AdvisoryAgent.ts`) and — when RAG is on — into **Scribe** (with only the read-only `retrieve_knowledge` tool). **Proto and Critic do not run the loop yet** (they get grounding via SharedContext, single-shot). The data-driven roster lives in `agent/dynamic/AgentRegistry.ts`.
- **Skills:** workflow-selected skills are folded into the **Scribe/Proto** system prompts at DI time (`di/services.ts` `composeFor('scribe'|'proto', …)` → `skills/registry.ts` `buildSystemPrompt`); a no-skills build sends the byte-identical base prompt. The **Critic is not yet wired** for skill injection (a follow-up).

## 4. RAG (auto-knowledge) — semantic when keyed, lexical feature-hash otherwise

`backend/src/knowledge/` behind a `KnowledgePort` (`KnowledgePort.ts`). Zero-touch, event-driven ingest (`IngestionSink.ts` subscribes per session) from conversation, agent output, GitHub repo (`ingest/RealGitHubRepoReader.ts` behind `AKIS_GITHUB_TOKEN`, mock otherwise), and uploads (`ingest/UploadSource.ts`). Pipeline: structure-aware chunking → secret/binary exclusion → content-hash dedup → idempotent `IngestQueue` (retry + dead-letter).

**Embeddings are semantic when an embedding key is set, lexical feature-hash otherwise.** `selectEmbeddingProvider` (`knowledge/embedding/ApiEmbeddingProvider.ts`) picks the real `ApiEmbeddingProvider` (OpenAI `text-embedding-3-small`, dim 1536) **only when an OpenAI key resolves** (env → KeyStore, the same sources as the chat provider); keyless and `NODE_ENV=test` stay on the offline `LocalEmbeddingProvider` (signed **feature-hashing**, dim 256, no network/key) — so the self-hostable default path is unchanged. Either way the vector half is fused with an **in-memory BM25** index via **RRF**, then an optional offline `LocalReranker` — all **tenancy-filtered by `user_id`/`session_id`**.

**BM25 now persists + re-hydrates on boot** (a correctness fix — it was previously in-memory only and lost on restart while the vector half survived). On a Postgres boot the lexical index is rebuilt from the SAME persisted corpus rows as the vector store (`api/server.ts` → `Bm25Index.hydrate(vectorStore.hydratedChunks())`), so both halves survive a restart in lockstep.

Ranking is still **brute-force JS cosine** over the in-memory index (the `PgVectorStore` delegates every read to an embedded `MemoryVectorStore`); a real `vector(N)` column + ivfflat index exist when pgvector is present (§5) but are **not yet the ranking path** — real ANN-at-scale + an API cross-encoder reranker remain deferred drop-ins behind the existing seams (`docs/NEXT.md`). RAG is read-only and holds no gate capability.

## 5. Persistence

`backend/src/store/` + `auth/` + `workflow/`. Postgres when `DATABASE_URL` is set, in-memory mocks otherwise. Idempotent boot migrations in `store/pg.ts` create: `users` (auth/OAuth identity), `sessions` (gate-bearing fields), `workflows` (**versioned** — a new row per version), `vector_chunks` (the persistent RAG corpus, re-hydrated into the in-memory index on boot). On boot `ensurePgVectorColumn` does a **guarded** upgrade of `vector_chunks.vector` to a real, indexable `vector(N)` (sized to the active embedder via `activeEmbeddingDim`) with a best-effort ivfflat cosine index — but **only when the `vector` (pgvector) extension is present**; if it is unavailable (plain `postgres:16`, a managed DB without it, CI without it) it **falls back to `double precision[]`** and never breaks boot. compose + CI use `pgvector/pgvector:pg16`. (The read path is unaffected either way — ranking still goes through the in-memory delegate; the column/index are a future-scale assist, §4.) Auth: JWT + OAuth + scrypt password hashing (`auth/jwt.ts`, `oauth.ts`, `password.ts`, `session.ts`, `cookie.ts`), CSRF origin matching. Password-reset links are delivered via a pluggable `Mailer` seam (`backend/src/mail/*`; unconfigured = dev-echo, enumeration-safe).

## 6. SSE — resumable live stream

`backend/src/api/sse.ts` + `events/bus.ts`. Orchestrator HTTP routes (`api/sessions.routes.ts`) expose a `GET /sessions/:id/events` SSE endpoint that streams typed `AkisEvent`s with a per-session monotonic **`seq`** in the `id:` line; the browser echoes it back as `Last-Event-ID`, so the stream **resumes across refresh/reconnect with no lost/duplicated steps** (server buffer with an overflow `reset` control frame; per-connection write-buffer ceiling guards OOM). FE client: `frontend/src/live/EventStreamClient.ts`.

## 7. The Studio (frontend)

`frontend/src/` — live-preview-first chat studio. Holds **no** gate authority (approve/confirm only POST to the gated routes). Key slices:

- **Chat / Run pipeline** (`chat/`) — `ChatStudio`, `RunPipeline` (the live per-agent step tree + gate cards), `HistoryMenu` (always-visible build history), `SpecCard`.
- **Chat-to-Build** — when "Ask AKIS" emits a spec inside a four-backtick `akis-spec` fence, the UI renders a one-click **Approve & Build** card (no copy-paste) that runs the unchanged `startSession` → same gates (`docs/CHAT_TO_BUILD.md`).
- **Agents & Workflows** (`agents/`, `workflows/`) — read-only roster + per-agent model picker; `WorkflowBuilder`/`WorkflowList`/`WorkflowPreview` (tighten-only gate policy, iterate budget clamped 1..3, RAG toggle).
- **Live preview** — built apps run/serve via `backend/src/preview/*` and are previewed in-browser.
- Markdown is rendered through one XSS-safe `<Markdown>` (no raw HTML); i18n via `frontend/src/i18n`.

## 8. Ops

`Dockerfile` + `docker-compose.yml` for self-hosting (`docs/SELF_HOSTING.md`). CI (`.github/workflows/ci.yml`) runs `tsc --noEmit` + vitest (backend) and a **v8 line-coverage gate** (≥80, ~86% today — frontend), a real-Postgres migration integration test, **boot-smokes the built image keyless against `/health`**, and a hermetic **chromium-only Playwright smoke** (`frontend/e2e/smoke.spec.ts` — loads the app, asserts the landing renders) in a separate `e2e` job.

**Release pipeline** (`.github/workflows/release.yml`): on a `v*` tag push / manual dispatch it builds the image, **keyless `/health` smoke-gates the publish**, then pushes to **GHCR (`ghcr.io/omeryasironal/akis-platform-mvp`, version + `latest`)** and cuts a GitHub Release. By design this is **self-host-an-image** (Ollama-style) — there is **no** live-host deploy step. A **full browser-driven E2E** of the whole studio flow is still future (`docs/NEXT.md`).
