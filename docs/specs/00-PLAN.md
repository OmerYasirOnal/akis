# PLAN — execution across all specs (worktree-safe)

This worktree `/Users/omeryasironal/Projects/akis-mcp-wt` on branch `feat/real-mcp` (forked from main @ b52cd70, which already carries slices 1–3) is where ALL of this is implemented and tested IN ISOLATION. `main` (the live-deployed branch) is never touched until a phase is unit-green + reviewed; only then does that phase merge to main + redeploy. Live-only verification (real OAuth/MCP/PR) happens at the end of a phase, against the real services, with the owner's accounts.

## Why a worktree
The MCP/auth/routes/FE work is large + touches the live auth + agent loop. Building it on a separate branch in a separate working dir means: the live box keeps running main; a half-built slice can't break production; each phase merges only when green + gate-keeper-clean. The slice-1–3 primitives are already on main (dormant, unwired, safe) — the worktree continues from there.

## Phase ordering (independent first, creds-gated last)

### Phase 1 — Scribe docs into the app (SPEC 02) — FIRST: pure code, no creds, high value
- ScribeAgent.writeDocs + Orchestrator.ts:333 injection + the :337 validator language fix.
- Unit: README in code.files, digest invariant, validator-passes-markdown, fail-soft, mock-green, idempotent.
- gate-keeper (touches the producer pipeline + digest path) → merge to main → redeploy → live: a real build now ships a README that pushes with the app.

### Phase 2 — GitHub push made REAL (SPEC 01 §8) — config + a small code fix
- P0 config: `AKIS_GITHUB_PUSH_TOKEN` + `AKIS_GITHUB_PUSH_REPO` on the box (🔴 owner: a fine-grained PAT, Contents+PR write). Fix pushGate.ts:52 dead URL (unit).
- Verify 🔴 live: a build → done → a REAL PR appears (not the mock URL). This alone resolves "push wasn't open."

### Phase 3 — Real MCP transport + server-side OAuth (SPEC 01 §2,§4) — code, unit-testable
- slice 4: StreamableHTTP transport + the OAuthClientProvider server adapter (DCR+PKCE), fake-SDK unit tests.
- slice 5: generalize the store to (userId, provider) + DCR client-info; `/mcp/<provider>/connect` + `/callback` routes; `mcpTransportFor` DI factory. Unit: route shape, signed state, fail-closed preflight, store round-trip.
- gate-keeper (auth + a new outward capability surface) → merge.

### Phase 4 — Gated writes + reads + UI (SPEC 01 §5,§6) — code, unit-testable
- slice 6: read allow-lists (Jira/Confluence/GitHub) + the write-PROPOSE bridge + `/external-writes` list + `/confirm` route (→ mint → executeExternalWrite).
- slice 7: FE Settings connect tiles + the confirm card + "publish docs to Confluence / open Jira issue".
- slice 8: agent wiring — per-user MCP read tools into Scribe/Proto grounding + the propose tools; live-stream observability.
- gate-keeper → merge.

### Phase 5 — LIVE e2e (SPEC 01 §10 slice 10) — needs the owner + real services 🔴
- Owner: enable Atlassian Rovo MCP (admin) + allowed domains; connect Jira/Confluence in Settings (browser OAuth, DCR — no app); connect GitHub (OAuth). 
- Run `transport.listTools()` live to capture the REAL write-tool names + inputSchemas (do NOT trust the old repo's custom names).
- e2e: connect → agent reads → proposes a Confluence page + a Jira issue → human confirms → both LAND; a real GitHub PR ships the built app + its README.
- Then: the feature is real → keep on main, redeploy, update THREAT-MODEL + SELF_HOSTING + memory.

### Phase 6 — Backlog (SPEC 03), schedulable independently
- A. Cost analytics (model on AgentMetrics + pricing + Analytics) — MED, no creds, gate-keeper (event schema).
- B. #18 usage history (after A); quota enforcement ✅ mechanism SHIPPED (`AKIS_USER_TOKEN_BUDGET`/`_PERIOD` → fail-closed 429), 🔶 only the NUMBER is the owner's; paid tier 🔶 (owner: pricing+Stripe) — deferred.
- C. #15 Docker −190MB — deliberate, boot-test in the worktree before any redeploy.

## What I need from the owner (decision/credential points) 🔶🔴
1. 🔴 A fine-grained GitHub PAT (Contents + PR write) on the target repo — to make push REAL fastest (Phase 2). OR register one GitHub OAuth app (per-user path).
2. 🔴 Atlassian: an admin enables the Rovo Remote MCP for the site + allowed domains; then you authorize in the browser (DCR = no app to register). For Phase 5.
3. 🔶 Free-quota NUMBER + over-quota policy (Phase 6 B) — the enforcement MECHANISM is shipped (`AKIS_USER_TOKEN_BUDGET`), only the number/policy is owner's. 🔶 Paid-tier pricing + provider (deferred).
4. 🔶 Confirm: $ cost estimate shown vs tokens-only (Phase 6 A); keep the Docker github-mcp-server as a fallback or drop it (SPEC 01 §7).

## Invariants every phase keeps
4 build gates untouched · no model-autonomous outward write (external-write gate) · secrets encrypted, never logged · external/remote content ephemeral (no RAG ingest) · signup stays closed · unit-green + gate-keeper before merge · live-verify before declaring done.

## Status
- Done on main: slices 1 (gate keystone), 2 (SSE+bearer transport), 3 (encrypted store).
- This worktree: specs written (00–03). Next: Phase 1 (Scribe docs) — pure code, start here.
