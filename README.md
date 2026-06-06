# akis-platform-mvp

Clean rebuild of [AKIS](../akis-platform) — an AI agent orchestration engine whose thesis is **quality trust**: AI agents do the work, but nothing ships until it passes **3 structural safeguards** (two human-approval gates + sealed, fail-closed verification) with a human in the loop.

> **Status: implemented (MVP, evolving).** The end-to-end agentic core runs today — idea → spec → human approval → code → real test → critic → human push-confirm — on a mock provider by default and on real LLMs (Claude/OpenAI/OpenRouter/Gemini) when a key is configured. Backend + frontend + live preview are built and tested. (`backend` + `frontend` + `shared` pnpm workspace; backend `pnpm test` is the gate.)

> 🔏 **See a real, verifiable build:** [`docs/showcase/`](docs/showcase/) holds an actual AKIS build's **signed Build Provenance Attestation** — verify its Ed25519 signature yourself with `node docs/showcase/verify-attestation.mjs` (zero deps, zero AKIS code). This is what a *provable* AI build looks like.

## One-line thesis

Not "more *agentic*" for its own sake — **agentic, but bounded and verifiable.** A main orchestrator agent ("AKIS") decides which sub-agents (Scribe / Proto / Trace / Critic) to dispatch, and the thesis is held by **3 inviolable structural safeguards** (which surface as the 4 properties below), not a rigid FSM:

1. **Spec-approval** — code-write is denied until a human approves the spec.
2. **Producer ≠ verifier** — only the verifier role may run tests.
3. **Verified = a real test** — `verified` latches only on a verifier run with ≥1 test that actually executed and passed (no false green).
4. **Push gate** — a GitHub push needs a branded token, mintable only when verified **and** human-confirmed.

Flexibility lives at the **edges** (agentic dispatch, a verified iterate loop, free ASK/CHAT); the gates are the spine and can never be loosened by config.

> **Note on the pivot:** the original `HANDOFF.md` locked an explicit FSM + transition table. Sub-project #1 **consciously reversed that** to an agentic core whose invariant is the structural safeguards (see `docs/superpowers/specs/2026-06-01-agentic-core-gates-design.md §0`). This README reflects the agentic-core reality that is actually built; `HANDOFF.md` is kept as the historical design record.

## What's built (sub-projects 1–10, merged)

| Area | What |
|---|---|
| **Agentic core + structural safeguards** | Orchestrator dispatches Scribe/Proto/Trace/Critic; gates enforced structurally (branded tokens, capability encapsulation). |
| **Real providers + keys** | Anthropic (default) / OpenAI / OpenRouter / Gemini behind one `LlmProvider` seam; encrypted `KeyStore`; `GET/PUT/DELETE /api/providers`. Mock fallback for tests/keyless runs. |
| **Live sub-agents** | Scribe (idea→spec) and Proto (spec→code) call the LLM and parse typed artifacts; Trace runs **real verification** — it boots the produced app and HTTP-probes the running server (**boot-smoke**, opt-in via `AKIS_REAL_TESTS`), minting `verified` only on a real ≥1-test pass. (A heavier browser Playwright/Cucumber runner exists in the tree but is **not** wired into the default boot.) When RAG is on, Scribe pulls grounding on demand via a bounded, read-only `retrieve_knowledge` tool-loop (Scribe only today). |
| **Live visibility** | Orchestrator HTTP routes + **resumable SSE** (per-session `seq` + `Last-Event-ID`; no lost/dup on reconnect). A **DEMO badge** marks mock-verified results — on the verify card + live preview, not just the header — so a demo build is never mistaken for a real-verified one. |
| **SharedContext** | One typed, read-only context every agent reads (no untyped blob). |
| **Auto-RAG** | Zero-touch, event-driven ingest + hybrid retrieve behind a `KnowledgePort`. Retrieval is **semantic when an OpenAI embedding key is set** (OpenAI `text-embedding-3-small`), and offline **feature-hash** otherwise — keyless/test stays self-hostable. BM25 + the vector corpus both persist + re-hydrate on boot (Postgres; a real `vector(N)` column when pgvector is present). Read-only, holds no gate capability. |
| **Real GitHub push (opt-in)** | The push gate can open a real PR via `RealGitHubAdapter` — selected **only** when `AKIS_GITHUB_PUSH_TOKEN` + a target repo are set, and only behind the `ApprovedPush` token (verified **and** human-confirmed). Default boot stays on the mock. |
| **Agents & Workflows tab** | Per-agent model picker (consumes `/api/providers`) + gate-safe workflow presets (tighten-only) + per-session selection. |
| **Chat-to-Build** | When "Ask AKIS" emits a build-ready spec (in a fenced `akis-spec` block), the UI renders it, offers a `.md` download, and a one-click **Approve & Build** runs the unchanged `startSession` → same gates + pipeline. No copy-paste, no new build path. See [`docs/CHAT_TO_BUILD.md`](docs/CHAT_TO_BUILD.md). |
| **Full-stack generation (Phase E/F/G)** | Proto emits multi-file static apps, zero-dependency `node:http` services, or full-stack apps on Node’s built-in `node:sqlite` with stdlib auth (scrypt + httpOnly session cookie); a deterministic guard blocks a backend-demanding spec from shipping as a static mock, and the preview boots the generated server for real. |
| **Real verification (boot-smoke)** | With `AKIS_REAL_TESTS=1`, Trace BOOTS the produced app and HTTP-probes the running server — `verified` latches only on a genuine ≥1-test pass (`demo:false`). Honest derivation: criteria that can't be mechanically asserted are recorded *skipped*, never faked green. |
| **Behavioral round-trip (`AKIS_ROUNDTRIP_VERIFY`)** | For a node-service whose spec names an `/api` path, verification also POSTs a unique marker then GETs it back — passing **only if the write persisted**, catching a "Potemkin backend" (200 but stores nothing) a GET-only check misses. Conservative: a non-2xx POST self-skips (never false-fails a healthy app). |
| **Build Provenance Attestation** | A signed build exports a portable, SLSA/in-toto-aligned attestation (`GET /sessions/:id/attestation`, + a Trust-card download) wrapping the Ed25519-signed passport — an **offline-verifiable receipt** a user hands a client. See [`docs/showcase/`](docs/showcase/). |
| **Durable audit ledger** | Every run event persists to an append-only `audit_events` table (when Postgres is configured) — a restart-durable, queryable trail (`GET /sessions/:id/audit`). |
| **Frontend** | React 19 + Vite + Tailwind v4; live-preview-first chat studio; rendered markdown via one XSS-safe `<Markdown>` (no raw HTML); the FE holds **no** gate authority (approve/confirm only POST to the gated routes). |

## Start here
1. **`README.md`** (this file) — current state + thesis.
2. **`docs/rag-and-agents-design.md`** + **`specs/rag-and-agents-spec.md`** — the additive auto-RAG + Agents/Workflows design and acceptance criteria.
3. **`docs/architecture-review.md`** — review of the core against the goals (flawless / real-time / dynamic / quality) + the Core Foundations prerequisites.
4. **`docs/roadmap.md`** + tracking issue #4 — milestone map (M0–M5).
5. **`MEMORY.md`** — durable decision + gotcha index.
6. **`docs/coordination-notes.md`** — cross-session notes (live agents, default Claude provider, shared context); **`specs/review/`** — independent zero-context spec review.
7. **`HANDOFF.md`** — historical design dossier (the pre-pivot FSM direction + the v1 audit). Read for *why*, not for *current* architecture.

## Running it
- Install: `pnpm install` (workspace root).
- Backend tests (the gate): `pnpm -C backend test` — `tsc --noEmit` strict + vitest.
- Live on real AI: set `ANTHROPIC_API_KEY` (env or via `/api/providers`) and the opt-in run flags (`AKIS_REAL_TESTS`, `AKIS_RAG`). With no key, the system runs the deterministic mock — **never a silent fake "verified"** in production (providers fail closed outside `NODE_ENV=test`).
- Run the published image (no local build): each tagged release publishes a smoke-gated image to GHCR, so you can `docker run -p 3000:3000 ghcr.io/omeryasironal/akis-platform-mvp:latest` directly (Ollama-style). See [`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md) for the full run + compose story.
