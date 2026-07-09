# AKIS — verifiable AI software development

[![CI](https://github.com/OmerYasirOnal/akis/actions/workflows/ci.yml/badge.svg)](https://github.com/OmerYasirOnal/akis/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

> **AI agents do the work — but nothing ships until a human approves it and a *real* test proves it.**

AKIS is a multi-agent software-development engine built around one uncomfortable question:

> **AI can write code. So why should we trust it?**

Most AI coding tools hand you an output and disappear — you can't see who checked it, what actually ran, or what "done" was based on. AKIS puts **verifiability** at the center instead of raw output. A team of role-separated agents does the work, and **four structural human-approval gates** sit above them: the AI literally cannot ship past a human, by design — not by a system prompt that asks it nicely.

- 🤖 **Four agents, separated roles** — **Scribe** writes the spec · **Proto** writes the code + tests · **Critic** reviews it adversarially · **Trace** verifies it by *actually running a test*.
- 🚧 **Four gates that can't be loosened by config** — ① a human approves the spec before any code is written · ② the producer can never be its own verifier · ③ `verified` latches only on a real test that executed and passed (**no false green**) · ④ a push to GitHub needs a token mintable only when verified **and** human-confirmed.
- 🔏 **Provable, not just claimed** — every verified build exports an **offline-verifiable, Ed25519-signed provenance attestation** you can hand to a client and check yourself.

> 🔏 **Want proof instead of a promise?** [`docs/showcase/`](docs/showcase/) holds a real AKIS build's signed Build Provenance Attestation — verify its signature yourself with `node docs/showcase/verify-attestation.mjs` (zero dependencies, zero AKIS code). That's what a *provable* AI build looks like.

> ⚡ **Try it in one command (no local build):** `docker run -p 3000:3000 -e AUTH_JWT_SECRET="$(openssl rand -hex 32)" -e AKIS_ALLOW_MOCK=1 -e AKIS_ALLOW_DEMO_IN_PROD=1 ghcr.io/omeryasironal/akis-platform-mvp:latest` → open `http://localhost:3000`. Runs on a deterministic mock out of the box; add an LLM key for real builds. (`linux/amd64`; on Apple Silicon / ARM, build locally — see [`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md).)

**Status — implemented MVP (evolving).** The end-to-end core runs today: idea → spec → human approval → code → real test → critic → human push-confirm. It runs on a deterministic mock provider by default and on real LLMs (Claude / OpenAI / OpenRouter / Gemini) when a key is configured. Backend + frontend + live preview are built, tested, and self-hostable. TypeScript pnpm monorepo (`backend` / `frontend` / `shared`); React 19 + Vite + Tailwind frontend. **Apache-2.0.**

---

## How the trust model works

Not "more *agentic*" for its own sake — **agentic, but bounded and verifiable.** A main orchestrator agent ("AKIS") decides which sub-agents (Scribe / Proto / Trace / Critic) to dispatch, while the thesis is held by **inviolable structural safeguards**, not a rigid state machine and not the model's good intentions:

1. **Spec-approval** — code-write is denied until a human approves the spec.
2. **Producer ≠ verifier** — only the verifier role may run tests.
3. **Verified = a real test** — `verified` latches only on a verifier run with ≥1 test that actually executed and passed (no false green).
4. **Push gate** — a GitHub push needs a branded token, mintable only when verified **and** human-confirmed.

Flexibility lives at the **edges** (agentic dispatch, a verified iterate loop, free ASK/CHAT); the gates are the spine and **can never be loosened by config**.

> **Note on the pivot:** the original `HANDOFF.md` locked an explicit FSM + transition table; the build consciously reversed that to an agentic core whose invariant is the structural safeguards (see `docs/superpowers/specs/2026-06-01-agentic-core-gates-design.md §0`). This README reflects the agentic-core reality that is actually built; `HANDOFF.md` is kept as the historical design record.

## What's built

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
| **Remote-MCP integration (Jira/Confluence/GitHub)** | Connect YOUR Atlassian/GitHub via **browser OAuth 2.1 + Dynamic Client Registration** (no app to register; tokens AES-GCM-encrypted at rest, never in the browser) — Settings → "Connected tools". The `McpTransport` seam carries both stdio+Docker (GitHub read grounding) and Streamable-HTTP/SSE (remote) servers. |
| **External-write gate (the 5th branded token)** | An agent/user only **proposes** a Jira issue / Confluence page; the write executes **only** after an explicit human confirm of the exact digest-bound, allow-listed content (`ApprovedExternalWrite` — a module-private branded capability, never autonomous). Owner-scoped propose→confirm routes + a studio "Publish to Jira/Confluence" card. |
| **Scribe build docs** | Scribe authors a README into the generated app; it merges into the file set **before** the VerifyToken digests it, so it ships + pushes through the same Gate 4 (digest-bound, never out-of-band). |
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
- Run the published image (no local build): each tagged release publishes a smoke-gated image to GHCR, so you can `docker run -p 3000:3000 -e AUTH_JWT_SECRET="$(openssl rand -hex 32)" -e AKIS_ALLOW_MOCK=1 -e AKIS_ALLOW_DEMO_IN_PROD=1 ghcr.io/omeryasironal/akis-platform-mvp:latest` directly (Ollama-style) — **`linux/amd64` only; on an ARM host build locally instead** (`docker compose up --build`). See [`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md) for the full run + compose story.
