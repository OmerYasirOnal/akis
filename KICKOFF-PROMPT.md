# KICKOFF PROMPT — AKIS Platform MVP

> Paste everything below the line into a **fresh session opened in `/Users/omeryasironal/Projects/akis-platform-mvp`.**

---

We are starting **AKIS Platform MVP** — a clean rebuild of AKIS (an AI agent orchestration engine) that embodies the architecture decided in the 2026-05-31 design session. This is a **continuation**, not a blank start.

## First, read these (in order), then summarize them back to me before doing anything else
1. `HANDOFF.md` — diagnosis, locked decisions, target architecture, port-vs-drop, bug-classes to design out, parallel model, open decisions.
2. `docs/v1-architecture-audit.md` — full evidence (6 subsystem maps + 3 strategy panels, with file:line citations) from the 9-agent audit of v1.
3. v1 repo for reference/porting: `/Users/omeryasironal/Projects/akis-platform` (the agents + prompts are the valuable IP to port).

## What is already decided (LOCKED — do not relitigate, build on these)
- Keep the **FSM / verification chain** (Scribe → human gate → Proto → Validator → Critic → Trace → push-gate). It is the thesis and the moat. **Not** full-agentic.
- Make the FSM **explicit** (one transition table; emit happens inside `transition()`).
- **Monolith app, modular files.** No microservices; split the god-files into one-purpose modules.
- **Flexibility at the edges:** intra-stage agentic loops + ONE verified iterate loop (Proto-iterate → Validator → Critic → Trace → gate) + free ASK/CHAT. Spine stays deterministic.
- **DevAgent → labeled "unverified"** (no silent GitHub push).
- Direction = **Approach A: Explicit Verified Pipeline.** Thesis framing = *"human-in-the-loop verification chain'li agentic orchestration."*

## Resolve these WITH me before writing any plan or code
1. **MVP ↔ v1 ↔ defense.** My default: v1 stays the working demo for the 2026-06-12 defense (untouched); this MVP is the parallel/post-defense clean hat. Confirm or correct.
2. Confirm **Approach A**.
3. **First vertical slice** of the MVP (my default: full `Scribe→gate→Proto→Validator→Critic→Trace→push-gate` end-to-end on the **mock provider** first, then real AI).
4. **Stack** (my default: keep Fastify 4 + TS strict + Drizzle + Postgres/pgvector + React 19 + Vite 7 + Tailwind v4).
5. **Reuse:** port v1 agent logic + prompts; rewrite orchestration + chat shell on the new seams.

## How to work (process)
- Use **superpowers**. This is creative work → start with the **brainstorming** skill to confirm the open decisions and scope the first slice, then **writing-plans** to produce the implementation plan, then implement test-first.
- **Do NOT scaffold or write code until the design for the first slice is approved.**
- Design for **isolation**: one purpose per module, well-defined interfaces, independently testable. If a file grows large, it's doing too much.
- **Bug-classes to design out from day one:** single source of truth for stage/SSE (backend stamps every event); no dual render paths; forgotten-emit impossible (emit inside transition); typed cross-stage state; explicit FSM; one verification-chain runner; push gate unreachable until approved; i18n lint gate.
- Lock the verification chain with a backend contract test **before** building stages on top of it.
- Plan for **3 parallel sessions**: disjoint folder ownership lanes (A = BE fsm+lifecycle, B = BE stages+agents, C = FE chat features); freeze cross-session contracts up front; `dev-up.sh --session N` port/DB isolation; scoped `dev-down.sh --this`; migration-index reservation; BE/FE separate PRs.

## Constraints
- Defense 2026-06-12; live AI demo; Turkish presentation; "bakkal" (non-developer, needs to trust quality) persona; thesis = quality trust (determinism + visible gates is the feature).
- The v1 demo must keep working — don't let MVP work jeopardize it.

Start by reading the three sources above and giving me your summary + your recommendation on the 5 open decisions. Then we brainstorm the first slice together.
