# akis-platform-mvp

Clean rebuild of [AKIS](../akis-platform) — an AI agent orchestration engine whose thesis is **quality trust**: AI agents do the work, but nothing ships until it passes **4 structural verification gates** with a human in the loop.

> **Status: implemented (MVP, evolving).** The end-to-end agentic core runs today — idea → spec → human approval → code → real test → critic → human push-confirm — on a mock provider by default and on real LLMs (Claude/OpenAI/OpenRouter/Gemini) when a key is configured. Backend + frontend + live preview are built and tested. (`backend` + `frontend` + `shared` pnpm workspace; backend `pnpm test` is the gate.)

## One-line thesis

Not "more *agentic*" for its own sake — **agentic, but bounded and verifiable.** A main orchestrator agent ("AKIS") decides which sub-agents (Scribe / Proto / Trace / Critic) to dispatch, and the thesis is held by **4 inviolable structural gates**, not a rigid FSM:

1. **Spec-approval** — code-write is denied until a human approves the spec.
2. **Producer ≠ verifier** — only the verifier role may run tests.
3. **Verified = a real test** — `verified` latches only on a verifier run with ≥1 test that actually executed and passed (no false green).
4. **Push gate** — a GitHub push needs a branded token, mintable only when verified **and** human-confirmed.

Flexibility lives at the **edges** (agentic dispatch, a verified iterate loop, free ASK/CHAT); the gates are the spine and can never be loosened by config.

> **Note on the pivot:** the original `HANDOFF.md` locked an explicit FSM + transition table. Sub-project #1 **consciously reversed that** to an agentic core whose invariant is the 4 gates (see `docs/superpowers/specs/2026-06-01-agentic-core-gates-design.md §0`). This README reflects the agentic-core reality that is actually built; `HANDOFF.md` is kept as the historical design record.

## What's built (sub-projects 1–10, merged)

| Area | What |
|---|---|
| **Agentic core + 4 gates** | Orchestrator dispatches Scribe/Proto/Trace/Critic; gates enforced structurally (branded tokens, capability encapsulation). |
| **Real providers + keys** | Anthropic (default) / OpenAI / OpenRouter / Gemini behind one `LlmProvider` seam; encrypted `KeyStore`; `GET/PUT/DELETE /api/providers`. Mock fallback for tests/keyless runs. |
| **Live sub-agents** | Scribe (idea→spec) and Proto (spec→code) call the LLM and parse typed artifacts; Trace runs a real verifier (Playwright/Cucumber, opt-in). |
| **Live visibility** | Orchestrator HTTP routes + **resumable SSE** (per-session `seq` + `Last-Event-ID`; no lost/dup on reconnect). |
| **SharedContext** | One typed, read-only context every agent reads (no untyped blob). |
| **Auto-RAG** | Zero-touch, event-driven ingest + hybrid retrieve behind a `KnowledgePort` (embedded now; pgvector drops in behind the same seam). Read-only, holds no gate capability. |
| **Agents & Workflows tab** | Per-agent model picker (consumes `/api/providers`) + gate-safe workflow presets (tighten-only) + per-session selection. |
| **Chat-to-Build** | When "Ask AKIS" emits a build-ready spec (in a fenced `akis-spec` block), the UI renders it, offers a `.md` download, and a one-click **Approve & Build** runs the unchanged `startSession` → same gates + pipeline. No copy-paste, no new build path. See [`docs/CHAT_TO_BUILD.md`](docs/CHAT_TO_BUILD.md). |
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
