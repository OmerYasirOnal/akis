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
| Gatekeeper | **Orchestrator + 4 branded-token gates** | `backend/src/orchestrator/`, `backend/src/gates/` |
| Trust gates | spec_approval, verify, push_confirm, critic-resolution | `backend/src/gates/*` |

Producer/verifier separation is already structural: Proto cannot mint a VerifyToken; only the real test run can. Deploy (push) requires `ApprovedPush` minted from a `VerifyToken` — **no deploy before verification, no deploy without human confirm** is already enforced by construction. Our job is to make this *legible and premium* in the product, and to deepen Proto from single-file toys to real multi-file full-stack apps.

## 1. Current repo analysis (confirmed)

- **Stack:** pnpm monorepo — `backend` (Fastify + tsx, uncompiled TS), `frontend` (React 19 + Vite + Tailwind, cosmic dark theme teal `#07D1AF`/violet), `shared`. TS strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`. vitest.
- **Agents:** Scribe/Proto/Trace/Critic behind a DI seam; `LlmProvider` abstraction (Anthropic/OpenAI/OpenRouter/Gemini/Mock), fail-closed `createProvider`. Skill-composed prompts injected per agent.
- **Gates:** 4 structural gates via branded tokens (`ApprovedSpec`, `VerifyToken`, `ApprovedPush`, critic-resolution). Non-bypassable by construction.
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

**Phase C — Pipeline timeline + trust panels (legibility).** Make the 9-step flow explicit and labeled with trust copy: User prompt → Spec → **Human spec approval** → Task breakdown → Builder → **Independent verifier** → Critic/security/UX → Preview → **Deploy gate**. Add visible Trust Gate copy: "Spec approved by human", "Builder & verifier are separate", "Deployment requires explicit approval", "Every run is auditable". Polish: preview rail (the collapsed vertical rail looks unfinished), Code multi-file tree, Verification results cards, Deploy/Push approval card (disabled until verify passes — already enforced server-side; reflect it in UI).

**Phase D — Agent-activity strip ("atoms-like").** A persistent compact live strip showing which agent is running right now, always visible during a run.

**Phase E — Capability: multi-file output.** Shift `PROTO_SYSTEM` so non-trivial apps emit a proper multi-file structure (index.html + separate css/js/components), still static-previewable. Addresses the recurring "yine 1 dosya" — while keeping truly trivial apps lean. Verify via live build.

**Phase F — Capability: real backend (node-service).** Deepen + harden Proto's `node-service` path so a full-stack app actually boots and serves through the preview proxy. Verify a real Express/stdlib server build end-to-end.

**Phase G — Capability: SQLite persistence + auth (the chosen full-stack target).** Proto can emit a SQLite-backed CRUD + signup/login/session app. This is the "real SaaS MVP" proof. Largest; sequenced last.

**Cross-cutting linchpin (after B/C, before E–G):** persistent + *editable* project workspace so agents EDIT existing files (diff/patch) instead of regenerating — enables "continue from where we are" and multi-turn SaaS growth.

## 4. Service / API layer (backend)

Expose a clean service interface mapping to the brief (wrapping existing orchestrator calls; deterministic mock behind the same interface where real codegen isn't wired):
`createProjectFromPrompt`, `generateSpec`, `approveSpec`, `startAgentRun`, `getAgentRunStatus`, `approveDeploy`. These are thin adapters over the existing session/gate APIs — not a new engine.

## 5. Data model (documented; in-memory/JSON unless safe to migrate)

Entities: `projects`, `specs`, `agent_runs`, `agent_steps`, `verification_reports`, `approval_gates`. AKIS has no relational DB today, so MVP documents the schema and uses the existing persisted-session model; a migration is a roadmap item, not MVP risk.

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
