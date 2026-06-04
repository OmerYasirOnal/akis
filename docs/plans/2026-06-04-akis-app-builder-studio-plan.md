# AKIS App-Builder Studio — Implementation Plan

> **Repositioning:** AKIS becomes an *AI app-building studio that turns ideas into verified, shippable software through human-approved agent gates.*
> **TR:** *AKIS, fikirleri insan onaylı AI agent kapılarından geçirerek doğrulanmış ve yayına hazır yazılıma dönüştüren bir app-building stüdyosudur.*
>
> Status: DRAFT for `/workflow` review. Branch: `feature/akis-app-builder-studio`.

## 0. Thesis — we are NOT starting from zero

The brief asks for a SpecAgent → human gate → BuilderAgent → independent VerifierAgent → Critic → preview → deploy gate pipeline with producer/verifier separation and auditability. **AKIS already has exactly this.** The repositioning is 80% product-framing + UX clarity and 20% capability-deepening (multi-file, full-stack, deploy). We must NOT rewrite the orchestration core.

| Brief term | Existing AKIS unit | Location |
|---|---|---|
| SpecAgent | **Scribe** | `backend/src/orchestrator/subagents/ScribeAgent.ts` |
| BuilderAgent | **Proto** | `backend/src/orchestrator/subagents/ProtoAgent.ts` |
| VerifierAgent | **Trace** (real tests, separate role) | `backend/src/orchestrator/subagents/` + Trace lane |
| CriticAgent | **Critic** (security/UX/quality review) | `backend/src/orchestrator/subagents/critic/` |
| Gatekeeper | **Orchestrator + structural safeguards** | `backend/src/orchestrator/`, `backend/src/gates/`, `backend/src/verify/` |

**Structural safeguards (CORRECTED after code review — get this exactly right; the moat rests on it):** AKIS enforces **3 structural safeguards**, NOT "4 gates":
1. **`ApprovedSpec`** — token-file gate (`backend/src/gates/specGate.ts`), emitted to the user via `Orchestrator.emitGate()`. No code is produced before the human approves the spec.
2. **`ApprovedPush`** — token-file gate (`backend/src/gates/pushGate.ts`), emitted via `emitGate()`. No deploy/push without explicit human confirm.
3. **`VerifyToken`** — minted **fail-closed** by a *sealed capability* in `backend/src/verify/verifier.ts` (`resolveVerifier` only, no `createVerifier`): a token mints **only on a genuine ≥1-test pass**, regardless of which agent asks. `ApprovedPush` can only be minted from a live `VerifyToken` → **no deploy before verification.**

**Critic-resolution is NOT a gate.** It is an *automatic, recoverable* state emitted via `Orchestrator.emitRecovery()`; `resolveCritic()` lets the user **proceed** without critic approval. The critic shapes status/trust but never blocks the pipeline by construction. (Do not pitch it as a non-bypassable gate.)

Producer/verifier separation is structural: `ProtoAgent` receives `{bus, provider}` and `TraceAgent` receives `{bus, verifier}` — never both (`services.ts` DI). Proto cannot mint a VerifyToken; only the real test run can, and only on a ≥1-test pass. Our job is to make this *legible and premium* in the product, and to deepen Proto from single-file toys to real multi-file full-stack apps.

## 1. Current repo analysis (confirmed)

- **Stack:** pnpm monorepo — `backend` (Fastify + tsx, uncompiled TS), `frontend` (React 19 + Vite + Tailwind, cosmic dark theme teal `#07D1AF`/violet), `shared`. TS strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`. vitest.
- **Agents:** Scribe/Proto/Trace/Critic behind a DI seam; `LlmProvider` abstraction (Anthropic/OpenAI/OpenRouter/Gemini/Mock), fail-closed `createProvider`. Skill-composed prompts injected per agent.
- **Gates:** 3 structural safeguards — 2 token-file gates (`ApprovedSpec`, `ApprovedPush` via `emitGate()`) + 1 fail-closed capability-sealed `VerifyToken`. Critic-resolution is automatic/recoverable (`emitRecovery()`), not a gate. (See §0.)
- **Live:** resumable SSE (seq/Last-Event-ID), `useLiveChat` → `EventStreamClient` → `foldSessionView`/`foldChat`; `RunPipeline` 5-stage view; `ChatThread` activity.
- **Preview:** `Workspace.materialize` → `AppDetector` (vite|next|node-service|static|unsupported) → `PreviewRegistry` (install/launch/probe) → `/preview/:id/*` reverse proxy + WS upgrade tunnel; iframe sandbox `allow-scripts allow-forms allow-popups` (+ `allow="clipboard-write"`).
- **Persistence:** sessions persisted; encrypted `KeyStore` (AES-256-GCM) currently **server-wide** (multi-tenant blocker). No relational DB — in-memory + JSON file persistence.
- **Dev:** `dev.sh` (backend :3000 / frontend :5173), `AKIS_DEMO_VERIFY=1` mock verification, real Claude via KeyStore.

## 2. Non-goals (YAGNI)

- No rewrite of the orchestrator, gate tokens, or LlmProvider seam.
- No "more autonomy" framing — the claim is **more trust / verification / control**.
- No real cloud deploy in MVP (deploy = gated push to mock/GitHub; real hosting is roadmap).
- No relational DB migration for AKIS's own state in MVP unless low-risk (document schema; keep in-memory/JSON where unsafe).
- No per-account key isolation in *this* plan (tracked separately; it's the multi-tenant track).

## 3. Phased delivery (atoms-sized PRs, each gated + tested)

**Phase A — Research + Product spec (docs only).** `docs/research/ai-app-builder-landscape.md` (competitive matrix: a0.dev, Atom.new, Replit Agent, Lovable, Bolt, v0, Cursor, Firebase Studio — what to copy structurally, what to avoid, AKIS differentiation) + `docs/product/akis-app-builder-studio-spec.md` (vision, personas, journey, MVP screens, agent pipeline, gate model, data model, architecture, non-goals, risks, acceptance criteria).

**Phase B — Studio shell UX.** Reframe the Studio entry as a prompt hero: *"What do you want to build?" / "Ne oluşturmak istiyorsun?"* with template chips (SaaS MVP, Landing Page, Admin Dashboard, Marketplace, Internal Tool, Mobile App Prototype). Each chip seeds a prompt. Keep the develop-in-chat model from `390e785`. Premium, minimal; reuse the existing teal/violet tokens (no new design system — one already exists in Tailwind config + cosmic theme).

**Phase C — Trust legibility (the moat, made visible) — RECOMMENDED FIRST after A.** The differentiation is *capability-token gates*, not *approval buttons* — but it's invisible today (trust copy in a buried docs tab; Proto/Trace render as two undifferentiated numbered steps; Deploy looks clickable before verify). Concrete spec:
- **Inline trust copy** at each step, TR+EN i18n keys (lockstep, per the global i18n rule): "Spec approved by human" / "Builder & verifier are separate" / "Deployment requires explicit approval" / "Every run is auditable".
- **Role badges:** Builder = Proto, Verifier = Trace, rendered visually distinct so producer/verifier separation is obvious.
- **Persistent Trust/audit panel:** which gates cleared + token mints (`ApprovedSpec`, `VerifyToken`, `ApprovedPush`) with timestamps — an inspectable event log (a downloadable JSON audit export is nice-to-have).
- **Deploy gate visually disabled until `session.verified`** (server already enforces it; UI must reflect it, not just rely on the 409).
- Polish: preview rail (collapsed vertical rail looks unfinished — concrete done-criteria: Tailwind tokens, expand/collapse, collapsed-state content, responsive breakpoints), Code multi-file tree, Verification results cards.
- *Fastest credible value: the backend guarantees already exist; this is mostly FE over a verified foundation — it's what turns the hidden moat into a demoable differentiator.*

**Phase D — Agent-activity strip ("atoms-like").** A persistent compact live strip showing which agent is running right now, always visible during a run.

**Phase B.5 — Persistent + editable project workspace (LINCHPIN, hard prerequisite for E–G).** Today `Workspace.materialize()` is ephemeral and the Orchestrator overwrites `code.files` — every follow-up regenerates from scratch, so "add a users table" loses approved work and develop-in-chat is impossible. Scope: session-keyed persistent workspace; extend Proto input with prior `ctx.code.files`; a diff/"only-changed-files" output hint in `PROTO_SYSTEM`; a round-trip test proving the workspace survives a second build. Not optional polish — E–G depend on it.

**Phase E — Capability: multi-file output.** Shift `PROTO_SYSTEM` so non-trivial apps emit a proper multi-file structure. **Concrete output grammar:** `index.html` + `styles.css` + `app.js` (+ `/components/*.js` as needed), still static-previewable via the existing static server. **Risk:** Proto's single-call 16384-token budget makes large multi-file emission tight (truncation) — mitigate by allowing a continued/second emission call or per-file budgeting. **Acceptance:** `backend/test/integration/multifile-boot.test.ts` asserts ≥3 files emitted + the static preview serves them.

**Phase F — Capability: real backend (node-service).** Deepen Proto's `node-service` path so a full-stack app actually boots and serves through the preview proxy. **Concrete choices:** backend framework = **Express** (widely-known, reliable) with a `package.json` start script; server listens on `process.env.PORT`. **Risk:** the readiness probe (~10s default) races real Express+DB boot (3–8s) — harden with more attempts + exponential backoff + stderr-tail in the failure reason. **Acceptance:** `backend/test/integration/nodeservice-boot.test.ts` boots a generated Express app and asserts HTTP 200 within a bounded time.

**Phase G — Capability: SQLite persistence + auth (the chosen full-stack target).** Proto emits a SQLite-backed CRUD + signup/login/session app — the "real SaaS MVP" proof. **Concrete choices:** SQLite client = **better-sqlite3** (sync, simple, reliable in a node-service); auth = cookie-session + hashed passwords (mirror AKIS's own auth patterns). **Acceptance:** an end-to-end boot test that signs up, logs in, and round-trips a row. Largest; sequenced last, after B.5 + E + F.

## 4. Service / API layer (backend)

Expose a clean service interface mapping to the brief (wrapping existing orchestrator calls; deterministic mock behind the same interface where real codegen isn't wired):
`createProjectFromPrompt`, `generateSpec`, `approveSpec`, `startAgentRun`, `getAgentRunStatus`, `approveDeploy`. These are thin adapters over the existing session/gate APIs — not a new engine.

## 5. Data model + persistence scope (MVP explicit)

**MVP persistence model (decided):** projects/specs/runs are stored **per-session as JSON** (the existing persisted-session + workspace model, extended by Phase B.5 to survive follow-ups). The studio is **server-wide in demo mode** (a user sees the sessions on this server) — acceptable for the investor demo. **Per-account key isolation is explicitly OUT OF SCOPE** for this plan (tracked as the separate multi-tenant track; KeyStore stays server-wide here). Entities documented for the future relational model: `projects`, `specs`, `agent_runs`, `agent_steps`, `verification_reports`, `approval_gates` — a migration is a roadmap item, not MVP risk.

**Develop-in-chat model (defined):** after a build completes, the conversation stays live; a follow-up message ("add login", "make it multi-page") feeds Proto the **prior `ctx.code.files`** (Phase B.5) and runs an *edit/iterate* build on the SAME project — not a from-scratch regenerate — re-entering the same gates. **Acceptance:** a follow-up message produces a diff over the existing workspace, the prior approved files survive, and at least one end-to-end happy-path test maps each of the 9 pipeline steps to its UI surface.

## 6. Tests

Gate logic (no build before spec approval; no deploy before verify pass; no push without human approval), pipeline state transitions, service-layer behavior, and a live-build smoke for Phases E–G. All existing gate tests must stay green.

## 7. Acceptance criteria

- Studio entry reads "What do you want to build?" with working template chips.
- Full 9-step pipeline is visible and labeled with trust copy.
- Deploy gate is disabled until verification passes (UI reflects the server-enforced rule).
- A full-stack app (multi-file + backend) builds, verifies, previews, and ships through the gates (Phases E–G).
- Producer (Proto) and verifier (Trace) remain separate; no gate is bypassable.
- README updated; research + product-spec docs committed.

## 8. Risks

- **Scope:** this is multi-week; mitigated by atoms-sized phased PRs, each independently shippable.
- **Capability proof (E–G):** real multi-file/backend reliability is unproven; mitigated by live-build verification per phase and the editable-workspace linchpin.
- **Preview reliability:** node-service boot through the proxy is the riskiest runtime path; harden + live-verify.
- **Don't loosen gates:** every phase must keep the 4 structural gates and iframe sandbox intact.

## 9. Deliverables map (brief A–I)

A→Phase A research note · B→Phase A product spec · C→Phases B–D UX shell · D→Phases E–G + service layer · E→§4 agent mapping (no new infra) · F→Phase C trust copy · G→§6 tests · H→README in Phase A · I→final PR summary. PR title: **"Transform AKIS into verified prompt-to-app studio."**
