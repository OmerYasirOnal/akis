# Zero-context review — `specs/rag-and-agents-spec.md` (2026-06-01)

Independent review by a fresh reviewer with no prior conversation context, reviewing the spec against `HANDOFF.md` and `docs/rag-and-agents-design.md`.

**Verdict:** APPROVE WITH CHANGES. The spec honors every locked decision (not full-agentic, deterministic spine, push-gate inviolable, single source of truth, typed state). Problems were concentrated in: untestable quality bar, undefined ingest-failure handling, and a cluster of privacy/tenancy/deletion gaps. None fatal; all closeable before M1.

---

## Findings & responses

Status legend: ✅ fixed in spec · 📝 deferred-with-rationale · 🔜 tracked for M0/M1.

### Blocking
- **B1 — F1-AC8 retrieval quality not measurable.** ✅ Rewrote F1-AC8 with a versioned golden eval set (≥20 query→chunk pairs) and a top-5 ≥80% bar asserted in CI.
- **B2 — F1-AC7 retry budget unbounded, no terminal behavior.** ✅ F1-AC7 now bounds retries (≤3, backoff 1s/4s/16s) and adds a dead-letter terminal state that is observable and never silently dropped.
- **B3 — Missing PII/privacy treatment for conversation ingestion.** 📝 + ✅ Adopted an **exclude-then-embed** posture: F1-AC12 mandates secret/binary exclusion; further PII redaction is explicitly deferred for the single-user post-defense MVP (R3 rationale below), and the third-party-processor implication is now stated in F1 non-functional.
- **B4 — Repo secret ingestion was a deferred open question.** ✅ Promoted to a mandatory prerequisite: F1-AC12. Removed secret/binary exclusion from open question #3.
- **B5 — Tenancy under-specified; spec vs design disagree.** ✅ Decided tenancy key = `user_id` + `workflow_id` (R5). F1-AC4 adds `userId` to provenance; F1-AC5 rewritten as a query-layer filter with a negative test; design §A.7 schema updated to match.
- **B6 — Stale `specs/review/` reference.** ✅ This file now exists; spec header points to it.

### Non-blocking
- **N1 — Spine dependency implicit.** ✅ Added a Dependencies section (D1) blocking M1/M4 on the transition table + event bus.
- **N2 — Flag-off needs a test hook.** ✅ F1-AC11 now asserts flag-off parity via the contract/smoke test toggled both ways.
- **N3 — F2-AC2 asserts skip before OQ#5 resolved.** ✅ F2-AC2 marked "only where legal," capped at v1's existing Trace-skip until OQ#5 resolves.
- **N4 — Perf bound undefined.** ✅ Added retrieval p95 < 300 ms on ≤50k chunks.
- **N5 — Provider default gates schema + privacy.** ✅ Open question #1 reworded to cover both dimension and processor choice; D3 flags it as an M0 blocker.
- **N6 — Phase vs M vocabulary.** ✅ Spec standardizes on M0–M5 and states the Phase→M mapping; design doc cross-references updated.
- **N7 — No observability ACs.** ✅ Added F1-AC14.

### Missing ACs added
- M-AC1 → **F1-AC7** (dead-letter terminal state).
- M-AC2 → **F1-AC5** (cross-tenant negative test).
- M-AC3 → **F1-AC12** (secret/binary exclusion).
- M-AC4 → **F1-AC13** (deletion / right-to-forget).
- M-AC5 → **F1-AC14** (observability).
- M-AC6 → **X-AC4** (rollback/migration safety).
- M-AC7 → **F1-AC15** (re-index on model change).
- M-AC8 → **F2-AC10** (version immutability for in-flight runs).
- M-AC9 → **F1-AC16** (provenance integrity for citations).

---

## Open-question responses
- **R3 (PII):** For the single-user, post-defense MVP the corpus is the user's own data viewed only by that user, so secret/binary exclusion (F1-AC12) is sufficient; full PII redaction is deferred and revisited before any multi-tenant use.
- **R5 (tenancy):** Scope by `user_id` + `workflow_id`. `knowledge_chunks` carries `user_id`; the retrieval query always filters on it. This supersedes design §A.7's workflow-only scoping (design updated).

## Still-open (carried to roadmap open questions, not blocking the spec)
1. Embedding provider default (+ `vector(N)` + processor) — blocks M0 schema freeze.
2. Rerank budget within the p95 bound.
3. Repo full-vs-changed-files + max size (secret/binary exclusion is now settled).
4. Prompt-variant authoring (curated vs raw).
5. Skip scope (which stages/gates).
