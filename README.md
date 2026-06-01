# akis-platform-mvp

Clean rebuild of [AKIS](../akis-platform) — an AI agent orchestration engine with a human-in-the-loop **verification chain** (Scribe → gate → Proto → Validator → Critic → Trace → push-gate) as its spine.

**Not yet implemented.** This folder currently holds the design handoff from the 2026-05-31 architecture session.

## Start here
1. **`HANDOFF.md`** — diagnosis, locked decisions, target architecture, scope, open decisions.
2. **`KICKOFF-PROMPT.md`** — paste into a fresh session to begin work.
3. **`docs/v1-architecture-audit.md`** — full evidence from the 9-agent audit of v1 (raw JSON: `docs/v1-architecture-audit-raw.json`).
4. **`docs/rag-and-agents-design.md`** — additive design for the zero-touch auto-RAG knowledge layer + the Agents/Workflows tab (post-defense, edges-only, spine untouched).
5. **`docs/roadmap.md`** — milestone/phase plan (M0–M5) for the RAG & Agents work; mirrored as GitHub issues.
6. **`MEMORY.md`** — durable decision + gotcha index; read first to recover context fast.
7. **`docs/architecture-review.md`** — review of the agentic core + plan against the goals (flawless / real-time / dynamic / quality); Core Foundations prerequisites + added acceptance criteria.
8. **`docs/coordination-notes.md`** — cross-session notes for the agentic-core/providers session: live agents, default Claude provider, shared context environment.

## One-line thesis of the design
Don't go more *agentic* — go more *explicit and verifiable*. Keep the FSM/verification chain (it's the thesis), keep the monolith **app** but split the monolith **files**, and put flexibility at the edges (verified iterate loop + free ASK/CHAT), never in the spine.
