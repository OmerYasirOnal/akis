# Coordination Notes — for the agentic-core / providers session

> **Audience:** the session building `feat/agentic-core-gates` (PR #1) + `feat/real-providers` (PR #2).
> **From:** the RAG/Agents planning session (PR #3) + an independent code review + the product owner's 2026-06-01 requirements.
> **Why:** align the core so it serves the product goals (flawless, real-time, dynamic) and the two additive features. Please read before continuing #2/preview work.

---

## 0. Reassurance first (verified)
- ✅ **No secret leaked.** Checked `feat/real-providers`: no `keys.json` / real `.env` is tracked or ever committed — only `backend/.env.example` (names only). The gitignore hardening was correctly preventive, not a cleanup of a real leak. Good.
- ✅ The gate kernel, provider seam, catalog, encrypted KeyStore, and the review→fix→re-review loop are sound. Keep that discipline.

---

## 1. Heed these (from the independent code review — `docs/architecture-review.md`)
- **CF2 — make the sub-agents LIVE (top priority).** Today Scribe/Proto/Trace are **deterministic stubs**; only the Critic calls the LLM. So the product's actual output (spec + code) is still fake. Each sub-agent must run through `createProvider().chat(...)` and **emit `tool_call`/`tool_result`/`preview` events** (currently never emitted). This is the difference between "real providers" and "real critic only."
- **CF6 — fail closed, not open.** `createProvider` currently falls back to the mock on a misconfigured/unknown provider **in production** → a misconfig silently produces fake "verified" output. Outside `NODE_ENV=test`, a misconfigured provider/key must **fail loudly**, never silently mock.
- **CF1/CF5 — the live UI needs delivery:** orchestrator HTTP routes + an **SSE endpoint** with a **resumable** stream (per-session monotonic `seq` + server buffer + `Last-Event-ID`), or the UI loses/dupes steps on refresh. (Research-backed; see review §3.)
- **confirmPush double-push window** and the **exported `createVerifier` + public `recordVerification`** capability gap — close when convenient (review §2). _(B2, lane/trust-hardening: the exported `createVerifier` leak is CLOSED — the constructor is now module-private and the only Verifier surface is `resolveVerifier(spec)`, built from the trusted TestRunner factories. The full separate-process signed verifier remains deferred.)_

---

## 2. NEW product requirements (owner, 2026-06-01)

### 2.1 Default Claude provider — every agent live by default
- **Ship Anthropic (Claude) as the DEFAULT provider** so the platform is **live out of the box** — not the mock. Every agent (AKIS + Scribe/Proto/Trace/Critic) runs on a real model by default.
- **Key handling (security — non-negotiable):** the default Claude key comes from **env (`ANTHROPIC_API_KEY`) or the encrypted KeyStore** — **NEVER hardcoded or committed.** "Fixed Claude API" = Claude is the default *provider*, not a checked-in *key*.
- The loop default model stays cost-aware (`claude-haiku-4-5-20251001`); the **model picker overrides per agent** (e.g. AKIS=Opus 4.8, Proto=Sonnet 4.6) via the catalog + `/api/providers`.
- The mock remains only for `NODE_ENV=test` and as an explicit opt-in — **not** the silent production fallback (ties to CF6).

### 2.2 Shared context environment — one common context all agents share
The owner wants **a shared environment of common context info that every agent reads, and that AKIS (the main agent) uses to call the others.** Design it on the existing seams (do NOT reinvent a blob):

- **`SharedContext` (per session, typed):** a single, append-mostly view assembled from the existing single sources of truth:
  - `SessionState` (idea, spec, code, gate states) — already exists;
  - the `AkisEvent` log (conversation `text`, agent outputs, `verify`, gate events) — already the backend-stamped source of truth;
  - **retrieved knowledge** from the RAG `KnowledgePort.retrieve()` (the auto-RAG layer) — grounding from prior sessions/repo/uploads;
  - a small **typed scratchpad** for explicit cross-agent facts (NO untyped `Record<string,unknown>` bag — v1's `intermediateState` mistake).
- **Read access:** when AKIS dispatches a sub-agent, it passes a **read view of `SharedContext`**; the sub-agent builds its prompt from `base prompt + selected skills + SharedContext slice + retrieved knowledge`.
- **Write access:** an agent contributes back **only by emitting typed events / returning a typed output** (which also feed RAG ingestion). One write path, no hidden mutation. This keeps the "single source of truth" + "typed cross-stage state" invariants.
- **AKIS dispatch:** the `dispatch_scribe|proto|trace|critic` tools (and any custom agent) carry the shared context; sub-agents are **callable by the main agent** with consistent context. This is the "ana agent onları çağırabilsin + ortak context" requirement.
- **RAG ties in here:** `retrieve_knowledge` is the tool that pulls into `SharedContext`; auto-ingestion writes every session's outputs back so future sessions share the accumulated context.

### 2.3 New acceptance criteria (added to `specs/rag-and-agents-spec.md`)
- **CORE-AC1 (live agents):** every core sub-agent produces its artifact via a real provider call (verified by a test that asserts the provider was invoked), not a hardcoded literal.
- **CORE-AC2 (default Claude):** with `ANTHROPIC_API_KEY` present (env or KeyStore) and no other config, all agents run on Claude; with nothing configured outside tests, the system fails loudly (no silent mock).
- **CORE-AC3 (no committed keys):** CI/secret-scan asserts no key material is ever committed; default key path is outside the repo.
- **F2-AC16 (shared context):** all agents read a typed `SharedContext` (SessionState + event log + retrieved knowledge + typed scratchpad); the only write path is typed events/returns — no untyped shared blob.
- **F2-AC17 (AKIS dispatch with context):** AKIS dispatches every agent (core + custom) with a read view of `SharedContext`; a dispatched agent never reaches gate capabilities it isn't entitled to.

---

## 3. Who builds what
- **Core session (you):** CF1, CF2, CF5, CF6, default-Claude wiring (2.1), and the `SharedContext` assembly on `SessionState`+event-bus (2.2). These are core/spine work.
- **This planning lane (RAG/Agents, PR #3):** the `KnowledgePort` that feeds `SharedContext`, the `retrieve_knowledge` tool, the Agents/Workflows tab + model picker + live preview — all consuming the seams above.

Coordinate on the frozen contracts before parallel dispatch: `SharedContext`, `KnowledgePort`, `WorkflowConfig`, the resumable event `seq`.
