# AKIS — What's Left / Next Priorities (2026-06-03)

> Honest, code-grounded view of the remaining gaps. The MVP runs end-to-end today (idea → spec → human approval → code → real test → critic → human push-confirm) on a mock provider by default and on real LLMs when a key is set; M0–M5 (auto-RAG + Agents/Workflows) are merged. This doc is the counterpart to `docs/roadmap.md` (what shipped) — it lists what is **deferred-by-design** vs **genuinely TODO**, so any "source of truth" planning flow has real targets.
>
> See also: `README.md` (current state), `docs/roadmap.md` (milestone status), `THREAT-MODEL.md` (the explicit trust boundary), `MEMORY.md` (durable decisions).

## Shipped since the last sync (#61–#71, 2026-06-03)

A batch of deep-gap PRs merged **after** the previous version of this doc. The items they closed have moved out of "deferred/TODO" below — kept honest about exactly what landed vs what is still future:

- **#61 real semantic embeddings** — `ApiEmbeddingProvider` (OpenAI `text-embedding-3-small`, dim 1536) is selected behind the existing `EmbeddingProvider` port **only when an OpenAI key resolves** (env/KeyStore). Keyless and `NODE_ENV=test` stay on the offline `LocalEmbeddingProvider` (feature-hash, dim 256). So retrieval is **semantic when keyed, lexical feature-hash otherwise** (§2).
- **#63 pgvector + BM25 persistence** — `vector_chunks.vector` is migrated to a real `vector(N)` column **when the `vector` extension is present** (guarded fallback to `double precision[]` otherwise), and **BM25 now persists + re-hydrates on boot** (was lost on restart — a correctness fix). The hot-path ranking still goes through the in-memory delegate (JS cosine); the ivfflat index exists but is **not yet the ranking path** (§3).
- **#64 Scribe tool-loop** — `ScribeAgent` runs the existing bounded loop with **only** the read-only `retrieve_knowledge` tool when RAG is on; RAG-off is byte-identical single-shot. **Scribe only** — Proto and Critic stay single-shot (§4).
- **#65 skill injection** — workflow-selected skills now shape **Scribe/Proto** system prompts; the **Critic is not yet wired** (out-of-scope follow-up, see §6).
- **#67 coverage + E2E smoke** — a vitest v8 line-coverage gate (≥80, ~86% today) + a hermetic chromium-only Playwright **smoke** (loads the app, asserts the landing renders) in a separate CI job (§7).
- **#68 reset-email** — a pluggable SMTP `Mailer` seam (unconfigured = dev-echo, enumeration-safe); **#69** closed a reset-email latency oracle (fire-and-forget send).
- **#70 release pipeline** — `.github/workflows/release.yml`: on a `v*` tag / manual dispatch, builds the image, **keyless `/health` smoke-gates the publish**, pushes to **GHCR (`ghcr.io/omeryasironal/akis-platform-mvp`, version + latest)**, and cuts a GitHub Release. No live-host deploy (self-host-an-image model) (§7).
- **#71 demo badge** — the demo-mode warning now renders **on the verify card + preview** (an additive `demo` flag on the verify/preview events), not just the header.

## How to read this

- **Deferred-by-design** = a deliberate scope decision for the MVP; the seam exists, the upgrade drops in behind it without touching callers. Not a bug; a known boundary.
- **Genuinely TODO** = a stated goal not yet met; closing it is real work, not just a swap behind an existing seam.

---

## Earlier round (#51–#59) + handoff to the COMPLETION MASTER PLAN

> The deep-gap batch (#61–#71) that followed is summarized in **"Shipped since the last sync"** at the top; this section is the prior round that set up the handoff.

Eight PRs were fresh-context reviewed and merged to `main` in that round (main was green: backend **595** / 3-skip, frontend **169**, tsc clean, build ok):

- **#59** trust-hardening — prod **fail-closed demo mode** (`AKIS_ALLOW_MOCK`/`AKIS_DEMO_VERIFY` refuse to boot under `NODE_ENV=production` without `AKIS_ALLOW_DEMO_IN_PROD=1`), `/health` now returns `mode:'live'|'demo'`, an amber "DEMO · mock-verified" header badge, the `createVerifier` capability leak closed (only `resolveVerifier(spec)` is public), and dead `orchestrator/parallel.ts` removed.
- **#58** custom advisory-agent UI in the Workflow Builder (**closes item 5 below**) + a tighten-only per-edge `phase` dispatch; advisory agents can never hold a gate capability (enforced in the UI palette *and* server validation).
- **#57** docs-sync (this planning layer) · **#56** in-app `/docs` manual · **#53** crypto tamper-detection test · **#51** provider error detail · **#52** dotenv loader quote/comment fix.

**Maps onto the COMPLETION MASTER PLAN:** `P0-DOCS-1`, `P1-CORE-1`, `P3-CLEAN-1`, `P4-FE-1` were already DONE before this batch; the deep gaps below (`P2-RAG-1`, `P1-CORE-2`, `P2-RAG-2`, `P3-AGENT-2`) plus the P3/P4/P5 tasks have **now landed** — see the **"Shipped since the last sync (#61–#71)"** note above. The deep-gap order table that used to live here has been retired now that the work merged.

**P1-CORE-1 variance — now closed (#71):** the earlier demo-honesty (#59) put the badge in the **header** only and used `AKIS_ALLOW_DEMO_IN_PROD=1` + a `/health` `mode` field. **#71** delivered the stronger placement the plan wanted — an additive `demo:true` flag on the verify/preview **events** + the badge **on the verify card & preview panel** (not just the header).

**Deep gaps as merged (was the order 1 → 3 → 2 → 4):**

| Gap (this doc) | Master-plan task | Status |
|---|---|---|
| Real semantic embeddings (§2) | `P2-RAG-1` | **DONE (#61)** — semantic when an OpenAI key resolves; offline feature-hash otherwise |
| Real GitHub push | `P1-CORE-2` | **DONE (#62)** — opt-in `RealGitHubAdapter`, behind the `ApprovedPush` gate, selected only when `AKIS_GITHUB_PUSH_TOKEN` + target repo are set |
| pgvector column + persisted BM25 (§3) | `P2-RAG-2` | **DONE (#63)** — BM25 persists + rehydrates; `vector(N)` column when the extension is present; ANN-as-ranking still future |
| Core-pipeline tool-loop (§4) | `P3-AGENT-2` | **Scribe DONE (#64)** — Proto/Critic still single-shot |

---

## 1. Production-grade trust isolation — *deferred-by-design (named in THREAT-MODEL.md)*

- **Today:** one trust domain, one OS process. The 4 gates give **integrity** (no forged/typed-around tokens; verifier/approval capabilities are module-private), but **not confidentiality** against a hostile first-party module in the same realm. `LocalDirectSandbox` (`backend/src/exec/Sandbox.ts`) scrubs secret env vars and kills runaway process groups — **hygiene + blast-radius reduction, NOT an isolation boundary.**
- **What's left:** a real boundary — a separate verifier process running AI-generated code under Docker `network=none` / gVisor / a microVM, with results signed by an externally-held Ed25519 key. The `Sandbox` and verifier seams are already shaped for this drop-in.
- **Why deferred:** the MVP thesis is *quality trust, not security*; the boundary is the same one that "run untrusted AI-generated code" requires regardless, and is scoped to that future sub-project.

## 2. Real semantic embeddings — *DONE 2026-06-03 (PR #61, keyed; offline default unchanged)*

- **Shipped:** `ApiEmbeddingProvider` (`backend/src/knowledge/embedding/ApiEmbeddingProvider.ts`) is a real semantic embedder — OpenAI `text-embedding-3-small` (dim 1536), one batched `POST /v1/embeddings`, L2-normalized so cosine == dot. `selectEmbeddingProvider` picks it **only when an OpenAI key resolves** (env `OPENAI_API_KEY` → KeyStore `openai`, the SAME sources as the chat provider). So retrieval is **semantic when an embedding key is set, lexical feature-hash otherwise**.
- **Still the default:** keyless and `NODE_ENV=test` stay on the offline `LocalEmbeddingProvider` (signed feature-hash, dim 256, no network/key) — the self-hostable, reproducible-out-of-the-box path is byte-for-byte unchanged. Combined with BM25 and fused via RRF (`retrieve/hybrid.ts`) either way.
- **Still future:** an API **cross-encoder** behind the `Reranker` seam (`retrieve/Reranker.ts`) — today's reranker is the offline lexical-overlap `LocalReranker`/`NoopReranker`; and a **golden-eval retrieval quality gate** (§6) to actually measure that the semantic path improves top-k. There is no quality threshold yet.

## 3. pgvector column + persisted BM25 — *BM25-persist + vector(N) column DONE (PR #63); ANN-as-ranking still TODO*

- **Shipped (#63):**
  - **BM25 now persists + re-hydrates on boot.** Previously BM25 was in-memory only and was **silently lost on restart** while the vector half survived (a correctness bug). On a Postgres boot the lexical index is now rehydrated from the SAME persisted `vector_chunks` rows as the vector store (`api/server.ts` → `Bm25Index.hydrate(vectorStore.hydratedChunks())`), so **both halves of hybrid retrieval survive a restart** in lockstep. This is the real win.
  - **`vector_chunks.vector` becomes a real `vector(N)` column when the `vector` extension is present.** `ensurePgVectorColumn` (`backend/src/store/pg.ts`) does a GUARDED `CREATE EXTENSION IF NOT EXISTS vector` → `ALTER … TYPE vector(dim)` (sized to the active embedder via `activeEmbeddingDim`) → best-effort ivfflat cosine index. If the extension is unavailable (plain `postgres:16`, a managed DB without it, CI without it) it **falls back to `double precision[]`** and never breaks boot. compose + CI use `pgvector/pgvector:pg16`.
- **Still TODO — ANN is not yet the ranking path:** the hot-path ranking **still goes through the in-memory delegate (`MemoryVectorStore`, JS cosine)** — `PgVectorStore` delegates every read there and only write-throughs to Postgres. The `vector(N)` column + ivfflat index exist but are **not** consulted for ranking yet, so this is **not "ANN-at-scale"**. Making the ANN index the actual ranking path (so retrieval scales past a single-user corpus without re-ranking in JS), plus a **perf gate** (the `p95 < 300 ms` target is unbenchmarked), is the remaining work.
- **Why the remainder is TODO:** brute-force JS cosine is correct and fine for the single-user MVP corpus; routing reads through the ANN index is a real change to the read path, not a swap.

## 4. Core-pipeline tool-loop — *Scribe DONE (PR #64); Proto/Critic still TODO*

- **Shipped (#64) — Scribe only:** when RAG is on, `ScribeAgent` (`backend/src/orchestrator/subagents/ScribeAgent.ts`) composes the spec through the EXISTING bounded tool-loop (`agent/tools/toolLoop.ts`) with **only** the read-only `retrieve_knowledge` tool in scope (built via the same `buildAdvisoryTools` allow-list the advisory agents use), so it pulls grounding **on demand** and each use surfaces as a real `tool_call`/`tool_result` on the live stream. **RAG-off is byte-identical single-shot** (the loop is never built; the system prompt gains the retrieve hint only on the RAG-on path). Scribe is a producer: the tool scope can **never** include a gate capability.
- **Still TODO — Proto + Critic stay single-shot.** `ProtoAgent` and `CriticAgent` still make a single dispatch each, grounded via the pre-assembled read-only SharedContext (`renderKnowledge`), not an in-turn tool-loop. Extending the same bounded, gate-free loop to them (so they too can pull grounding on demand) is the remaining piece.
- **Why TODO:** it changes those agents' control flow (today deliberately a single dispatch); the loop is proven on the advisory path and now Scribe first.

## 5. Custom-agent authoring UI — *DONE 2026-06-03 (PR #58)*

- **Shipped:** the Workflow Builder (`frontend/src/workflows/WorkflowBuilder.tsx`) can now add/edit/remove **custom advisory agents** (name, dispatch edge, optional provider/model, instructions, advisory tools), persisted via the existing workflow save path. The advisory tool palette never offers a gate capability and server validation (`workflow/validate.ts`) rejects one — advisory narration stays ephemeral, never ingested as trusted grounding. The 4 gates + tighten-only validation are untouched.

## 6. Quality + observability gates — *genuinely TODO*

- **Golden-eval retrieval gate (F1-AC8):** **not built.** No `≥20 query→chunk` golden set with a top-5 ≥80% quality gate exists in `backend/test`; retrieval is covered by unit/contract tests but not a measured quality threshold. (Now more relevant: with semantic embeddings shipped (§2), this is the gate that would actually prove the keyed path improves top-k.)
- **OpenTelemetry observability (F2-AC15):** **partial.** RAG metrics are surfaced via `RagService.getMetrics` + `/api/knowledge` and run analytics exist (`backend/src/analytics`), but there is no OTel span/metric export.
- **Critic skill injection (#65 follow-up):** **not wired.** Workflow-selected skills now shape the **Scribe/Proto** system prompts (`backend/src/di/services.ts` `composeFor('scribe'|'proto', …)`), but the Critic is constructed without a skill-composed prompt — folding selected skills into the Critic prompt is the out-of-scope follow-up to #65.

## 7. Release pipeline + E2E — *release pipeline + E2E smoke DONE (PRs #67, #70); full browser E2E + live-host deploy still TODO*

- **Shipped:**
  - **Release pipeline (#70)** — `.github/workflows/release.yml`: on a `v*` tag push / manual dispatch, it builds the existing multi-stage Docker image, runs it **keyless and smoke-gates the publish on `/health`** (the same smoke `ci.yml`'s ops job uses — never ship an image that doesn't boot), then pushes to **GHCR (`ghcr.io/omeryasironal/akis-platform-mvp`, both the version tag and `latest`)** and cuts a GitHub Release pointing at `docs/SELF_HOSTING.md`. Auth is the built-in `GITHUB_TOKEN` (no host, no user secret).
  - **E2E smoke (#67)** — a hermetic, **chromium-only** Playwright smoke (`frontend/e2e/smoke.spec.ts`) loads the built app and asserts the landing renders, in a **separate CI `e2e` job**. Plus a vitest **v8 line-coverage gate** (≥80, measured ~86% — `frontend/vite.config.ts`).
  - **(Existing)** CI (`ci.yml`) still runs `tsc --noEmit` + vitest, a real-Postgres migration integration test, and **boot-smokes the built image keyless against `/health`**; self-host `Dockerfile` + `docker-compose.yml` (`docs/SELF_HOSTING.md`).
- **Still TODO:**
  - A **full browser-driven E2E** of the whole studio flow (idea → spec → approve → build → verify → push-confirm) against a live build — the current smoke proves the app loads, **not** that the end-to-end flow works in a browser.
  - A **live-host deploy** step. By design AKIS is self-host-an-image (Ollama-style), so the release publishes a runnable GHCR image rather than deploying to one managed host — a live-host deploy target is intentionally out of scope but remains absent.

---

## Snapshot table

| Area | Status | Deferred-by-design vs TODO |
|---|---|---|
| Production trust isolation / sandbox | hygiene only (`LocalDirectSandbox`) | **deferred-by-design** |
| Real semantic embeddings | semantic when keyed; offline feature-hash otherwise (PR #61) | **done (keyed)** |
| pgvector column + persisted BM25 | BM25 persists + `vector(N)` when extension present (PR #63); ranking still JS cosine | **done** / ANN-as-ranking **TODO** |
| Core-pipeline tool-loop | Scribe via `retrieve_knowledge` loop (PR #64); Proto/Critic single-shot | **Scribe done** / rest **TODO** |
| Custom-agent authoring UI | shipped (PR #58) | **done** |
| Release pipeline (GHCR image) | tag/dispatch → smoke-gated GHCR push + GitHub Release (PR #70) | **done** |
| E2E smoke + coverage gate | chromium smoke + v8 coverage ≥80 (PR #67) | **done** |
| Golden-eval retrieval quality gate | not built | **TODO** |
| Real ANN-at-scale + perf gate | column/index exist but not the ranking path | **TODO** |
| OpenTelemetry observability | metrics surfaced; no OTel export | **TODO** |
| Full browser E2E (whole flow) | smoke-only today | **TODO** |
| Live-host deploy | self-host image only (by design) | **deferred-by-design** |
| Critic skill injection | Scribe/Proto wired (PR #65); Critic not | **TODO (follow-up)** |
