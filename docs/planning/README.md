# AKIS — Planning Layer

> The planning layer has **no separate plan files**. It is a thin pointer at the three real, kept-in-sync sources of truth. Any "source of truth" planning flow (a planning agent, a status check, a roadmap review) should target these — not invent its own state. This exists to **end documentation drift**: there is one place that says where the targets live.

## Sources of truth (in priority order)

1. **`../roadmap.md`** — milestone status (M0–M5: auto-RAG + Agents/Workflows). Each item is ticked against the file that implements it, or left unchecked with an honest one-line reason. **This is the canonical milestone tracker.** (Some older docs refer to it as `ROADMAP.md`; the real path is lowercase `docs/roadmap.md`.)
2. **`../NEXT.md`** — what's left / next priorities, each marked **deferred-by-design** vs **genuinely TODO** and grounded in code. Use this to pick the next piece of work.
3. **`MEMORY.md`** (repo root) — durable decisions, gotchas, and the running status index across sessions. The "why" behind choices that the roadmap/NEXT only state as outcomes.

## Supporting context (read for grounding, not as the plan)

- **`../../README.md`** — the canonical *current* product state + the 4-gate thesis.
- **`../architecture-review.md`** — historical 2026-06-01 review, now carrying a **SUPERSEDED** banner correcting its stale "no SSE / agents are fake" findings while preserving the corrections that still hold (no semantic embeddings, no pgvector ANN, no sandbox isolation).
- **`../../THREAT-MODEL.md`** — exactly what the gates guarantee and the deferred real trust boundary.
- **`../rag-and-agents-design.md`** + **`../specs/`** — the design + acceptance criteria the milestones were built against.

## Rules for keeping it honest (the point of this layer)

- A plan item is **done** only when it is grounded in a file in the tree — cite the path (the roadmap does this).
- Never upgrade language past the code: it is **"lexical + feature-hash retrieval"** not "semantic RAG"; the sandbox is **hygiene, not isolation**; demo/mock mode does **not** produce a real "verified" (providers fail closed outside `NODE_ENV=test`, and `verified` latches only on a real passing test when `AKIS_REAL_TESTS` is on).
- When code changes, update `../roadmap.md` (status) and `../NEXT.md` (remaining gaps) in the same change — that is how drift is prevented.
