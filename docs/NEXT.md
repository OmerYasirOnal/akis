# AKIS — What's Left / Next Priorities (2026-06-03)

> Honest, code-grounded view of the remaining gaps. The MVP runs end-to-end today (idea → spec → human approval → code → real test → critic → human push-confirm) on a mock provider by default and on real LLMs when a key is set; M0–M5 (auto-RAG + Agents/Workflows) are merged. This doc is the counterpart to `docs/roadmap.md` (what shipped) — it lists what is **deferred-by-design** vs **genuinely TODO**, so any "source of truth" planning flow has real targets.
>
> See also: `README.md` (current state), `docs/roadmap.md` (milestone status), `THREAT-MODEL.md` (the explicit trust boundary), `MEMORY.md` (durable decisions).

## How to read this

- **Deferred-by-design** = a deliberate scope decision for the MVP; the seam exists, the upgrade drops in behind it without touching callers. Not a bug; a known boundary.
- **Genuinely TODO** = a stated goal not yet met; closing it is real work, not just a swap behind an existing seam.

---

## Recently landed (2026-06-03) + handoff to the COMPLETION MASTER PLAN

Eight PRs were fresh-context reviewed and merged to `main` this round (main green: backend **595** / 3-skip, frontend **169**, tsc clean, build ok):

- **#59** trust-hardening — prod **fail-closed demo mode** (`AKIS_ALLOW_MOCK`/`AKIS_DEMO_VERIFY` refuse to boot under `NODE_ENV=production` without `AKIS_ALLOW_DEMO_IN_PROD=1`), `/health` now returns `mode:'live'|'demo'`, an amber "DEMO · mock-verified" header badge, the `createVerifier` capability leak closed (only `resolveVerifier(spec)` is public), and dead `orchestrator/parallel.ts` removed.
- **#58** custom advisory-agent UI in the Workflow Builder (**closes item 5 below**) + a tighten-only per-edge `phase` dispatch; advisory agents can never hold a gate capability (enforced in the UI palette *and* server validation).
- **#57** docs-sync (this planning layer) · **#56** in-app `/docs` manual · **#53** crypto tamper-detection test · **#51** provider error detail · **#52** dotenv loader quote/comment fix.

**Maps onto the COMPLETION MASTER PLAN (executed in a fresh session):** `P0-DOCS-1`, `P1-CORE-1`, `P3-CLEAN-1`, `P4-FE-1` are **already DONE** on `main` — the fresh session should skip them and start at the **deep gaps** below.

**P1-CORE-1 design variance:** the shipped demo-honesty (#59) uses `AKIS_ALLOW_DEMO_IN_PROD=1` + a `/health` `mode` field + a **header** badge. The plan spec instead wanted `AKIS_DEMO_MODE=1` + a `demo:true` stamp on the verify/preview **event** + the badge on the **gate card & preview panel** (stronger placement). Optional small follow-up rather than a redo.

**Owner-greenlit deep-gap order: 1 → 3 → 2 → 4** (1∥3 ok; do 1 before 2 so the embedding model fixes the `vector(N)` dim and avoids a double migration):

| # | Gap (this doc) | Master-plan task | Credential / prereq |
|---|---|---|---|
| 1 | Real semantic embeddings (§2) | `P2-RAG-1` | OpenAI key (`text-embedding-3-small`) via the existing KeyStore |
| 3 | Real GitHub push | `P1-CORE-2` | fine-grained GitHub PAT (repo scope) → `AKIS_GITHUB_PUSH_TOKEN` + target repo |
| 2 | pgvector + persisted BM25 (§3) | `P2-RAG-2` | `pgvector/pgvector:pg16` in compose + CI — **BM25-on-restart is the must-have; pgvector ANN is the nice-to-have** |
| 4 | Core-pipeline tool-loop (§4) | `P3-AGENT-2` | none (existing Claude key) — **deferrable if demo time is tight** |

---

## 1. Production-grade trust isolation — *deferred-by-design (named in THREAT-MODEL.md)*

- **Today:** one trust domain, one OS process. The 4 gates give **integrity** (no forged/typed-around tokens; verifier/approval capabilities are module-private), but **not confidentiality** against a hostile first-party module in the same realm. `LocalDirectSandbox` (`backend/src/exec/Sandbox.ts`) scrubs secret env vars and kills runaway process groups — **hygiene + blast-radius reduction, NOT an isolation boundary.**
- **What's left:** a real boundary — a separate verifier process running AI-generated code under Docker `network=none` / gVisor / a microVM, with results signed by an externally-held Ed25519 key. The `Sandbox` and verifier seams are already shaped for this drop-in.
- **Why deferred:** the MVP thesis is *quality trust, not security*; the boundary is the same one that "run untrusted AI-generated code" requires regardless, and is scoped to that future sub-project.

## 2. Real semantic embeddings — *deferred-by-design*

- **Today:** retrieval is **lexical**, not semantic. `LocalEmbeddingProvider` (`backend/src/knowledge/embedding/EmbeddingProvider.ts`) is signed **feature-hashing** (bag-of-words → fixed-dim, L2-normalized) — deterministic, offline, no key. Combined with in-memory BM25 and fused via RRF (`retrieve/hybrid.ts`). Describe it as "lexical + feature-hash hybrid retrieval", never "semantic RAG".
- **What's left:** a KeyStore-backed semantic embedding adapter (Voyage / OpenAI `text-embedding-3` / self-hosted) behind the existing `EmbeddingProvider` port, plus an API cross-encoder behind the `Reranker` seam (`retrieve/Reranker.ts`).
- **Why deferred:** offline + keyless keeps the stack self-hostable and the test suite reproducible out of the box (open-decision #1 in the roadmap, intentionally left to a later drop-in).

## 3. pgvector ANN + persisted BM25 — *genuinely TODO (persistence done; ANN not)*

- **Today:** the corpus **is persistent** — `PgVectorStore` (`backend/src/knowledge/store/PgVectorStore.ts`) write-throughs every chunk to a `vector_chunks` table and re-hydrates on boot, so RAG survives restart. **But** the `vector` column is a plain `double precision[]` (no pgvector extension), ranking is **brute-force JS cosine** over an in-memory index, and **BM25 is in-memory only** (rebuilt from the corpus on boot, `store/Bm25Index.ts`).
- **What's left:** a real ANN index (pgvector / HNSW) and a persisted lexical index so retrieval scales past a small single-user corpus without re-ranking everything in JS. There is **no perf gate** (the `p95 < 300 ms` target is unverified).
- **Why TODO:** brute-force is correct and fine for the single-user MVP corpus, but it does not scale; this is real work, not a swap.

## 4. Core-pipeline tool-loop — *genuinely TODO (advisory path has it; core pipeline doesn't)*

- **Today:** a bounded, provider-agnostic tool-loop (`backend/src/agent/tools/toolLoop.ts`) and the `retrieve_knowledge` tool (`agent/tools/retrieveKnowledgeTool.ts`) exist and are wired into the **advisory/ASK** agent (`agent/dynamic/AdvisoryAgent.ts`). The **core build pipeline (Scribe/Proto/Trace)** does **not** run that loop — those agents get RAG via the pre-assembled, read-only SharedContext (`renderKnowledge`), making a single LLM call each, not an iterative tool-using turn.
- **What's left:** let the core agents call tools (e.g. `retrieve_knowledge`) mid-turn through the same bounded loop — still behind the gates and with no gate-capability tools — so they can pull grounding on demand rather than only pre-assembled context.
- **Why TODO:** it changes the core agents' control flow (today deliberately a single dispatch); the loop is proven on the advisory path first.

## 5. Custom-agent authoring UI — *DONE 2026-06-03 (PR #58)*

- **Shipped:** the Workflow Builder (`frontend/src/workflows/WorkflowBuilder.tsx`) can now add/edit/remove **custom advisory agents** (name, dispatch edge, optional provider/model, instructions, advisory tools), persisted via the existing workflow save path. The advisory tool palette never offers a gate capability and server validation (`workflow/validate.ts`) rejects one — advisory narration stays ephemeral, never ingested as trusted grounding. The 4 gates + tighten-only validation are untouched.

## 6. Quality + observability gates — *genuinely TODO*

- **Golden-eval retrieval gate (F1-AC8):** **not built.** No `≥20 query→chunk` golden set with a top-5 ≥80% quality gate exists in `backend/test`; retrieval is covered by unit/contract tests but not a measured quality threshold.
- **OpenTelemetry observability (F2-AC15):** **partial.** RAG metrics are surfaced via `RagService.getMetrics` + `/api/knowledge` and run analytics exist (`backend/src/analytics`), but there is no OTel span/metric export.

## 7. Deploy pipeline / E2E — *genuinely TODO (CI smoke done; full E2E/deploy not)*

- **Today:** CI (`.github/workflows/ci.yml`) runs `tsc --noEmit` + vitest and **boot-smokes the built Docker image keyless against `/health`**; a self-host `docker-compose.yml` + `Dockerfile` exist (`docs/SELF_HOSTING.md`). A real-Postgres migration integration test runs in CI.
- **What's left:** a full browser-driven E2E run of the studio against a live build, and an actual release/deploy pipeline (publish image, tagged release, deploy target).
- **Why TODO:** the boot smoke proves the image starts, not that the whole user flow works end-to-end in a browser, and there is no deploy step yet.

---

## Snapshot table

| Area | Status | Deferred-by-design vs TODO |
|---|---|---|
| Production trust isolation / sandbox | hygiene only (`LocalDirectSandbox`) | **deferred-by-design** |
| Real semantic embeddings | lexical feature-hash today | **deferred-by-design** |
| pgvector ANN + persisted BM25 | corpus persists; ranking is JS brute-force | **TODO** |
| Core-pipeline tool-loop | advisory path only | **TODO** |
| Custom-agent authoring UI | shipped (PR #58) | **done** |
| Golden-eval retrieval quality gate | not built | **TODO** |
| OpenTelemetry observability | metrics surfaced; no OTel export | **TODO** |
| Deploy pipeline / browser E2E | CI boot-smoke + compose only | **TODO** |
