# AKIS App-Builder Studio — Product Spec

> **AKIS is an AI app-building studio that turns ideas into verified, shippable software through human-approved agent gates.**
> **TR:** *AKIS, fikirleri insan onaylı AI agent kapılarından geçirerek doğrulanmış ve yayına hazır yazılıma dönüştüren bir app-building stüdyosudur.*
>
> Companion docs: [implementation plan](../plans/2026-06-04-akis-app-builder-studio-plan.md) · [competitive landscape](../research/ai-app-builder-landscape.md)

## 1. Vision

The AI app-builder market (a0.dev, Atom, Replit Agent, Lovable, Bolt, v0, Cursor, Firebase Studio) has converged on **autonomy and one-click speed**, where "trust" means an undo button and a Git diff. AKIS's wedge is the uncontested gap: **legible, auditable trust** — an independent verifier, human-minted gate tokens, and an inspectable event log — delivered as a *product primitive*, not a checkbox. The promise: *Prompt yaz → AKIS planlasın → sen onayla → agent'lar üretsin → bağımsız verifier test etsin → preview gör → deploy onayla.*

## 2. User personas

- **Indie founder / solo builder** — wants a real MVP fast, but needs to trust it works before shipping to users.
- **Technical PM / agency** — turns client ideas into demoable, verified prototypes with an audit trail to show stakeholders.
- **Cautious engineer** — wants AI leverage without losing control; values the human gates and producer/verifier separation.

## 3. Primary user journey (the 9 steps, each a visible surface)

1. **Prompt** — "What do you want to build?" / "Ne oluşturmak istiyorsun?" (hero + template chips).
2. **Spec generation** — Scribe drafts a product spec (rendered as a readable, formatted card in-chat).
3. **Human spec approval** — `ApprovedSpec` gate; no code before approval.
4. **Task breakdown** — the plan the agents will execute.
5. **Builder** — Proto writes the code (multi-file; backend when needed).
6. **Independent verifier** — Trace runs real tests; mints a **fail-closed** `VerifyToken` (≥1-test pass only).
7. **Critic / security / UX review** — automatic, advisory; surfaced, never silently blocking (recoverable).
8. **Live preview** — the running app, embedded.
9. **Deploy gate** — `ApprovedPush` (minted only from a `VerifyToken`); human confirm required.

Develop-in-chat: after step 9, the conversation stays live — a follow-up ("add login") iterates on the SAME project (diff over the persisted workspace), re-entering the gates.

## 4. MVP screens

- **Studio entry** — prompt hero + template chips (SaaS MVP · Landing Page · Admin Dashboard · Marketplace · Internal Tool · Mobile App Prototype).
- **Conversation + spec card** — chat with the readable, approvable spec inline.
- **Pipeline timeline** — the 9 steps, labeled with trust copy; Builder/Verifier role badges.
- **Live preview · Code tree · Verification results · Trust/audit panel · Deploy gate card.**

## 5. Agent pipeline & gate model

Maps 1:1 to existing AKIS units — SpecAgent=**Scribe**, BuilderAgent=**Proto**, VerifierAgent=**Trace**, CriticAgent=**Critic**, Gatekeeper=**Orchestrator**. **3 structural safeguards** (see plan §0): `ApprovedSpec` + `ApprovedPush` (token-file gates via `emitGate()`) + fail-closed `VerifyToken` (sealed capability). Critic-resolution is automatic + recoverable (`emitRecovery()`), *not* a gate. Producer (Proto: `{bus, provider}`) and verifier (Trace: `{bus, verifier}`) are wired separately and never overlap — Proto cannot mint a VerifyToken.

## 6. Data model assumptions

MVP: per-session JSON persistence (existing session + workspace model, made durable by Phase B.5); server-wide demo scope; per-account key isolation **out of scope**. Future relational entities: `projects`, `specs`, `agent_runs`, `agent_steps`, `verification_reports`, `approval_gates`.

## 7. Technical architecture

pnpm monorepo — Fastify backend (tsx, uncompiled TS) + React 19/Vite/Tailwind frontend + shared. LlmProvider seam (Anthropic/OpenAI/OpenRouter/Gemini/Mock, fail-closed). Resumable SSE live stream. Preview: `Workspace.materialize` → `AppDetector` (vite|next|node-service|static) → `PreviewRegistry` → `/preview/:id/*` reverse proxy + WS tunnel; iframe sandbox `allow-scripts allow-forms allow-popups` (+ `allow="clipboard-write"`). Service layer (thin adapters over existing orchestrator): `createProjectFromPrompt`, `generateSpec`, `approveSpec`, `startAgentRun`, `getAgentRunStatus`, `approveDeploy`.

## 8. Non-goals

No orchestrator/gate-token/LlmProvider rewrite · no "more autonomy" framing · no real cloud deploy in MVP (gated push to mock/GitHub) · no relational-DB migration for AKIS's own state · no per-account key isolation in this scope.

## 9. Risks

Scope (multi-week → atoms-sized phased PRs) · capability proof E–G unverified (live boot tests per phase) · node-service boot races the readiness probe (harden) · Proto's 16384-token single-call budget risks multi-file truncation (per-file budgeting / continued emission) · gates/sandbox must never loosen.

## 10. Acceptance criteria

- Studio entry reads "What do you want to build?" with working template chips.
- The 9-step pipeline is visible and labeled with trust copy; Builder/Verifier visually distinct.
- Deploy gate is visually disabled until verification passes (reflecting the server-enforced rule).
- A full-stack app (multi-file + backend, Phases E–G) builds → verifies → previews → ships through the gates, proven by CI boot tests.
- Producer/verifier separation and the 3 structural safeguards remain intact and non-bypassable.
- Develop-in-chat: a follow-up message diffs over the persisted workspace without losing approved work.
- Research note + this spec + README committed.
