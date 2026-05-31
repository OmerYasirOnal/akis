# AKIS Platform MVP — Handoff & Research Dossier

> **Status:** design-direction set, NOT yet implemented. This folder is a **continuity handoff** so a fresh session can pick up exactly where the 2026-05-31 architecture session left off.
> **Read order:** this file → `docs/v1-architecture-audit.md` (full evidence) → then start work via `KICKOFF-PROMPT.md`.

---

## 🇹🇷 Özet (bu ne?)

AKIS v1 (`/Users/omeryasironal/Projects/akis-platform`) çalışıyor ama üç yapısal acı var: **kalabalık chat ekranı, kalabalık orchestrator, bug'lar bug doğuruyor + 3 paralel session çakışıyor.** 9-ajanlı derin bir audit yaptık. Bulgu: üçünün **tek kök nedeni** var — *dikey dikişi olmayan dev monolit dosyalar* (2877-satır orchestrator, 1359-satır ChatMessage) ve elle 4+ dosyada değiştirilen *paylaşılan mutable yüzeyler* (bir enum + bir tipsiz blob).

Karar: **FSM/pipeline'ı atmıyoruz** (verification chain = tezin ta kendisi ve farkımız). **Full-agentic'e gitmiyoruz** (determinizmi öldürür). **Monolit uygulama kalıyoruz ama monolit dosyaları bölüyoruz.** Esnekliği *kenarlara* koyuyoruz (stage-içi agentic loop'lar + tek **doğrulanmış** iterate loop + serbest ASK/CHAT). Yön: **Approach A — Explicit Verified Pipeline.** Bu MVP, o temiz mimariyi sıfırdan kurar; v1'deki değerli IP'yi (agent'lar + prompt'lar) taşır.

⚠️ **Açık karar (next session ilk işi):** Savunma 2026-06-12 (~12 gün). v1 çalışan demo OLARAK KALMALI. MVP'yi v1'in yerine geçirmek 12 günde riskli — önerimiz: **v1 = savunma demosu (dokunma), MVP = paralel/savunma-sonrası temiz hat.** Bunu kullanıcıyla netleştir.

---

## 0. How to use this doc

This dossier captures (1) the verified diagnosis, (2) the decisions already made and locked, (3) the north-star target architecture, (4) what must be ported vs dropped, (5) the bug-classes to design out, (6) the parallel-session operating model, and (7) the open decisions. The full audit evidence (6 subsystem maps + 3 strategy panels, with file:line citations) lives in `docs/v1-architecture-audit.md` (readable) and `docs/v1-architecture-audit-raw.json` (machine-readable).

---

## 1. Why a clean MVP — the three pains

The user (4th-year CSE graduation project, AI-assisted, 12 days from a live-AI defense) reported:

1. **Chat screen has too many features / too crowded.**
2. **Orchestrator is too crowded.**
3. **Fixing one bug spawns another; UI/UX usability is hard to preserve.** Plus: **wants 3 parallel dev sessions** on the same codebase without collisions.

These were treated as 4 problems. The audit proved they are **one problem with four faces.**

---

## 2. Diagnosis — one root cause (verified)

> **Low-altitude monoliths with no vertical seams.** A single enum (`ConversationUIState` / `PipelineStage`) and a single untyped blob (backend `intermediateState`, frontend the 57-key "prop bag") are **read-modify-written by hand across 4+ files.**

Consequences, and why they ARE the user's pains:
- A behavior change touches 4 files → **fix one, break another.**
- The same 4 files are exactly where **3 parallel sessions collide.** → **Decoupling IS parallelization.** Same work, not two jobs.

### Verified evidence (measured directly, not just claimed)
| Fact | Evidence |
|---|---|
| `backend/.../orchestrator/PipelineOrchestrator.ts` = **2877 LOC, ~117 methods, 9 responsibilities** | highest-churn file by **13×** (64 commit / 50 fix touches over last 300/200 commits) |
| `frontend/src/components/chat/ChatMessage.tsx` = **1359 LOC, 135 conditional branches, 18 message types**; `test_result` case alone ~285 LOC | single hardest file to change without breaking an adjacent case |
| Prop drill: `ChatPageLayout` 57–61 props → `ChatPanel` 56–60 → `PipelineDetailRail` 43–45, mostly pass-through | a small data add touches 4 files |
| `intermediateState: Record<string,unknown>` — ~20 cross-stage keys, ~102 hand-rolled spread refs | typo = **silent no-op three stages away** (audit: CRITICAL) |
| Orchestrator `emit` callback = `undefined` (`pipeline-factory.ts:512`); real SSE flows via separate `pipelineBus` | stage truth derived **3 independent ways** → "refresh gerekiyor" complaint |
| Dual plan-render path live (`ChatMessage.tsx:435` + `:511`; `conversationToChatMessages` `scribeCompletedExists`) | plan fix in one branch silently regresses the other |
| Verification chain re-implemented/skipped in **5 places** (normal build, iteration mode, retryProto, iteration push-timing, DevAgent) | DevAgent pushes to GitHub with **no** Scribe/gate/Validator/Critic/Trace |
| 16-member `PipelineStage` union, **no transition table**, ~67 scattered `store.update({stage})` sites | adding/auditing a transition means reading 9 files |
| `dev-down.sh` = global nuke (kills all worktrees' servers + shared DB); hardcoded `:3000/:5173`; single Drizzle `_journal.json` | parallel sessions collide; schema work un-parallelizable |

Note: `pages/chat/` is **already** decomposed into 14 hooks — decomposition was attempted, but complexity *relocated* (into the prop bag + `ChatMessage` god-renderer) rather than reducing. The MVP fixes the *seams*, not just the file count.

---

## 3. Decisions already made (LOCKED in the 2026-05-31 session)

1. **Keep the FSM / pipeline.** The verification chain (Scribe → human gate → Proto → DeterministicValidator → Critic → Trace → push-gate) is the **thesis and the moat**, not a legacy burden. Removing it doesn't simplify — it scatters the same state logic into ad-hoc, non-deterministic places.
2. **NOT full-agentic.** A single autonomous loop is non-deterministic and unverifiable = kills the thesis ("quality trust"). The defensible, more-advanced framing is **orchestrated multi-agent + verification gates**, which AKIS already is.
3. **Make the FSM EXPLICIT.** One transition table; emit happens *inside* the transition (forgotten-emit becomes structurally impossible). Explicit FSM is *simpler* to reason about (and demo-safer) than a hidden one.
4. **Monolith APP, not monolith FILES.** Keep single backend + single frontend (no microservices, no new infra). Split the god-files into one-purpose modules *inside* the monolith.
5. **Flexibility lives at the EDGES**, never in the spine:
   - intra-stage agentic loops (Proto/Scribe reflection/tool-use internally),
   - **ONE verified iterate loop** for "şunu da ekle / rengi değiştir" (Proto-iterate → Validator → Critic → Trace → gate) — this *gains* flexibility AND fixes the verification-bypass bug,
   - free **ASK/CHAT** intent (Q&A that does not push code).
6. **DevAgent → label "unverified."** (User-decided this session.) Remove silent GitHub push; surface output as explicitly outside the verification chain. Long-term: fold into the verified iterate loop.
7. **Thesis framing:** *"Human-in-the-loop verification chain'li agentic orchestration."* No rework needed to "look agentic" — name what already exists correctly. Approach B (a planner-agent that chooses stages) is the **future-work slide**, not 12-day work.

**Chosen direction: Approach A — "Explicit Verified Pipeline."** (Confirm with user; they pivoted to this MVP before an explicit "yes A".)

---

## 4. Target architecture (north-star for the MVP)

### 4.1 Backend — `pipeline/` (single Fastify monolith)
- **`fsm/transitionTable.ts`** — one `const Record<PipelineStage, allowedTargets>` + `transition(pipelineId, to, ctx)` that ALL stage changes route through. `transition()` does `store.update({stage})` **and** emits the SSE activity as one atomic step → forgotten-emit impossible; legality is table-driven (derive the table from current `assertStage` allowlists — encode existing behavior, don't redesign it).
- **`IntermediateState.ts`** — typed interface for the ~20 cross-stage keys + atomic `mergeIntermediateState(store, id, patch)` under lock. Typo → compile error. Kills last-writer-wins races.
- **Uniform `Stage` interface** — `run(ctx, input): StageOutcome` (discriminated union). Each stage a plugin (`scribeStage`, `protoStage`, `traceStage`, …). The exhaustive `never` handler is the ONE place side-effects + transitions fire (extends v1's proven Kademe-3 outcome pattern to Scribe + lifecycle).
- **`OrchestratorServices.ts`** — a DI container built once, replacing v1's three hand-wired 15–25-closure deps-builders. Orchestrator shrinks to a thin coordinator (~600 LOC target, vs 2877).
- **`postProtoQualityGates(ctx, input, dryRun)`** — the SINGLE verification-chain runner (Validator → Critic → Trace). All change paths (build, iterate, retry, dev-chat) go through it; GitHub push lives behind a `pushGate(ctx)` that is **unreachable until approved** (compile-time, not per-path discipline).
- **One `IterateLoop<T>`** — unify the twin Trace/Critic iterate loops; single shared retry budget; env-capped.

### 4.2 Frontend — `features/chat/` (feature-sliced)
- **`chatScreenMachine.ts`** — pure `deriveChatScreen({uiState, workflow, gates, terminalStatus}) → ChatScreen` discriminated union (composing / running / awaiting_approval / awaiting_push / awaiting_critic / completed / failed), each variant carrying its metadata (which surface renders, agent, glow, poll cadence, active gate). Replaces the 15-value `uiState` ladders duplicated across 4 files. Adds the missing first-class `failed` concept. **Single source of truth for "what should the screen show."**
- **Three contexts** (separate by update cadence to avoid over-render): `PipelineDataContext` (workflow-derived read-only), `PipelineActionsContext` (callbacks), `ChatStreamContext` (activities/SSE/screen). Replaces the 57→60→45 prop drill. Adding a field touches one file.
- **`conversationToRows.ts`** — ONE backend-event-driven row builder (collapses the two v1 transcript builders). Invariants: every row is a real backend event with a **backend-stamped timestamp** (no `new Date()` fallback, no FE-synthetic narrator rows, no Turkish substring status-matching); ONE canonical plan row (no dual path).
- **`thread/rowRenderers/`** — a `Record<rowKind, Component>` registry; one file per message family (`PlanRow`, `TestResultRow`, `FailureRow`, …). A new card = a new file, not an edit to a 1359-line switch.
- **`gates/PushGate.tsx`** — ONE component owning announcement + actions (kills the v1 split where buttons live in PreviewPanel and disappear when preview closes). Plus `CriticGate`, `ApprovalGate`.
- **i18n discipline** — every user string through the catalogue; a CI lint gate (extend v1's `scripts/lint/bakkal-language.mjs`) fails on hardcoded Turkish.

### 4.3 The verification chain (the spine — NON-NEGOTIABLE)
`Scribe (idea→spec) → HUMAN APPROVAL GATE → Proto (spec→code) → DeterministicValidator → Critic (adversarial review) → Trace (code→tests, auto-run) → PUSH-CONFIRM GATE → GitHub`. This sequence is the product. Lock it with a backend contract test on day one; every refactor runs behind that test + a real-AI smoke (`walkthrough.mjs`-style).

### 4.4 Where flexibility lives (the edges)
Spine deterministic; edges agentic: (a) intra-stage loops, (b) the one verified iterate loop, (c) free ASK/CHAT. Dev-chat = explicitly "unverified."

---

## 5. Feature inventory — port vs drop (for MVP scoping)

**LOAD-BEARING (must port):** Scribe/Proto/Trace pipeline; verification chain (DeterministicValidator, Critic); human gates (approval + push-confirm); explainability / Level-4 reasoning + cinema; multi-provider AI (**Claude primary**, OpenAI + Gemini secondary, OpenRouter last) with 3 model slots (planner/default/validation); GitHub MCP (Scribe requires it); auth; chat + intent routing (BUILD/ASK/FEEDBACK/CHAT).

**SUPPORTING (port if time):** RAG / knowledge / embedding; dashboard metrics; i18n TR+EN.

**NICE-TO-HAVE / defer or drop for MVP:** Studio, Marketplace, billing (Stripe), analytics, DevAgent (MVP ships it label-only or omits it).

The **agents + their prompts are the valuable IP** — port the agent logic + prompts; rewrite orchestration + chat shell.

---

## 6. Bug-classes to design OUT (lessons from v1)

1. **Single source of truth for stage/SSE** — one event stream; backend stamps every event at write time; no FE-synthetic rows; no 3-way derivation.
2. **No dual render paths** — one canonical PlanCard, one row builder.
3. **Forgotten-emit impossible** — emit inside `transition()`.
4. **Typed cross-stage state** — no untyped `intermediateState` bag.
5. **Explicit FSM** — no scattered `store.update`.
6. **One verification-chain runner** — never 5 copies.
7. **i18n lint gate** — no hardcoded TR strings.
8. **Push gate unreachable until approved** — structural, not disciplinary.

---

## 7. Parallel 3-session operating model

- **Disjoint ownership lanes by folder:** A = BE `orchestrator/fsm` + lifecycle; B = BE `stages/` + `agents/`; C = FE `features/chat`. Sub-slices (thread, gates, cinema) further disjoint.
- **Freeze cross-session contracts BEFORE dispatch:** BE `TransitionCtx`, `Stage`, `OrchestratorServices`; FE `ChatScreen`, the 3 context hooks, each slice's `index.ts`. These frozen interfaces are the ONLY shared surface.
- **Infra isolation (Phase 0, zero-risk):** `dev-up.sh --session N` (ports `3000+10N` / `5173+10N`, per-session DB `akis_dev_sN`, migrate-on-start); `dev-down.sh --this` (cwd-scoped; require `--all` for the old global behavior); migration-index reservation file before `db:generate`; `generate:types` reads the session's own backend URL.
- **BE/FE always separate PRs.**

---

## 8. Constraints & context

- **Defense:** 2026-06-12 (~12 days from 2026-05-31). Live AI demo. **Turkish** presentation. FSMVÜ format (oral + Q&A, 3-person committee, mandatory poster).
- **Persona:** "bakkal" — non-developer who needs to *trust* quality. Determinism + visible gates is the feature.
- **Thesis:** quality trust, not security. Verification chain is the central claim.
- **Hard rule:** the **v1 repo must keep working** for the demo. Treat MVP as parallel/post-defense unless the user explicitly decides otherwise.
- **User working style:** AI-assisted, high velocity; prefers low-risk additions over big rewrites; spec-first for non-trivial work; wants decisions made + justified, not constant approval-asking on big design docs.

---

## 9. Open decisions for the next session (resolve WITH the user first)

1. **MVP ↔ v1 ↔ defense relationship.** Recommend: **v1 = defense demo, untouched; MVP = parallel clean-room / post-defense.** (Greenfield finishing in 12 days is risky.) — *highest priority to confirm.*
2. **Confirm Approach A** (user pivoted before an explicit yes).
3. **MVP v1 scope / first vertical slice.** Recommend: end-to-end `Scribe → gate → Proto → Validator → Critic → Trace → push-gate` with the **mock provider first**, then wire real AI.
4. **Tech stack.** Recommend keep: Fastify 4 + TS strict + Drizzle + Postgres 16 (pgvector) + React 19 + Vite 7 + Tailwind v4. (Lets us port v1 code; proven.)
5. **Reuse strategy.** Recommend: port agent logic + prompts; rewrite orchestration + chat shell on the new seams.

---

## 10. References

- **v1 repo:** `/Users/omeryasironal/Projects/akis-platform` (branch at handoff: `audit/prompt-v3-design`).
- **v1 memory index:** `/Users/omeryasironal/.claude/projects/-Users-omeryasironal-Projects-akis-platform/memory/MEMORY.md` (esp. `dual_render_path_gotcha`, `sse_state_sync_pattern`, `chat_render_backend_events`, `iteration_verification_chain`, `devagent_verification_bypass`, `orchestrator_modular_structure`, `orchestrator_kademe3_done`, `parallel_session_infra_coordination`).
- **Full audit evidence:** `docs/v1-architecture-audit.md` + `docs/v1-architecture-audit-raw.json`.
- **Key v1 files to study before rebuilding:** `backend/src/pipeline/core/orchestrator/PipelineOrchestrator.ts`, `.../stages/runProtoAndTrace.ts`, `.../outcomes/*`, `backend/src/pipeline/agents/{scribe,proto,trace,critic}/*`, `frontend/src/components/chat/ChatMessage.tsx`, `frontend/src/pages/chat/ChatPage.tsx`, `frontend/src/utils/conversationToChatMessages.ts`, `frontend/src/services/api/workflows.ts`.

---

_Authored 2026-05-31 from a 9-agent parallel architecture audit + a design dialogue. Verification chain is the spine — preserve it in everything._
