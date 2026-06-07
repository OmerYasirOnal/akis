# AKIS — Comprehensive Audit & Improvement Backlog

> 2026-06-07 · 11-dimension multi-agent audit (specs↔code, moat/gates, BE correctness+perf, FE/studio, MCP feature, tests, security, i18n, deploy/ops, verify/trust), each finding adversarially verified.
> 11 dimensions · 54 confirmed findings · backlog of 54.

## Overall health

AKIS is NOT "fully done top-to-bottom," but it is much closer than its own docs admit, and its moat is genuinely intact: all four structural build gates plus the external-write gate were traced end-to-end as server-minted, module-private branded capability tokens with no bypass, client-mint, or autonomous-write path; signup stays closed, secrets are encrypted at rest, and remote-MCP content stays ephemeral. The headline reality is that the recently-shipped "real-MCP / external-write" batch is the weakest seam: the browser publish-to-Jira/Confluence flow is outright DEAD (missing content-type header), the Confluence tool name is wrong, the confirm route can double-write on a version conflict, the human-confirm prompt is English-only, and that whole path has no owner-scope/persistence regression tests — so the feature is "live" structurally but not actually usable or fully guarded. The other genuine gaps are a preview-route IDOR, a verifier false-RED that can block correct SPAs from ever verifying, a signed attestation that over-claims "verified" on demo runs, an uncodified production-deploy playbook, and a large band of canonical-doc drift (README/ARCHITECTURE/THREAT-MODEL never updated for the shipped MCP batch). No P0 (no sacred constraint is violated by shipped code); the work is a finite, executable P1/P2/P3 backlog.

## Reconciliation status — updated 2026-06-07

Tracking against the shipped tree. Items below the backlog are tagged `✅ CLOSED (<hash>)` inline; this section is the index.

**Closed (52 of 54)** — verified in code + tests; final `pnpm test` PASS (BE 1427/5-skip · FE 445 · tsc shared/be/fe clean · i18n EN/TR parity). The PR1–15 chain is complete; each branch was ≤300 LoC, ff-merged + pushed, gate-safe. (PR11–15 closed every previously-deferred CODE item: the Docker −190MB is now actually landed, the dead-i18n + refetch + quota-doc drifts are gone.)

| Commit | PR | Closed findings |
|---|---|---|
| `1bc133d` | P1 batch | #1 #2 #3 #4 #5 #6 #7 #8 #11 #14 (content-type · preview IDOR · confirm stale-version · SPA false-RED · attestation demo-marker · owner-scope test · README · confirm i18n · chat demo chip · connect-tile i18n) |
| `38958b3` | — | #12 #13 (externalWrites parity round-trip · migration assertion) |
| `a405f51` | docs | #18 #19 #20 #21 (THREAT-MODEL 5th gate · ARCHITECTURE MCP+gate · NEXT golden-eval · product-spec CI honesty) |
| `bed8815` | — | #22 #34 (payload visibility · SPA Link) |
| `1dcaf68` | PR2 | #23 #24 #26 #27 (deploy-box script · compose mem/pids/log limits · amd64 caveat · deploy runbook) |
| `9ef46fd` | PR3 | #33 (OAuth callback `state` CSRF/flow-integrity) |
| `0634eb3` | PR4 | #29 (opt-in `AKIS_REQUIRE_AUTH_FOR_BUILDS` — anonymous-session gap) |
| `48d3922` `ff783d8` `8dad4a4` | PR5a/b/c | #30 #43 #44 #46 #47 (at-most-once `executing` guard · demo→evidenceDigest · per-language validation · AKIS_REAL_TESTS overrides demo) |
| `c28596c` | PR6 | #16 (estimated per-build cost — dated price table + AgentMetrics.model + AnalyticsPage) |
| `cb41841` | PR7 | #17 #32 #45 (Atlassian read allow-list + provider-agnostic bridge + live-discovery harness) |
| `bc50298` | PR8 | #10 #36 #37 #38 (ModelPicker modal Esc/focus · aria-live flood → status region · redundant aria removed + iframe i18n · fallback i18n) |
| `4845ba7` `b8a9cab` | PR9a/b | #35 #40 #42 #50 #51 #54 (no-auto-boot-on-reopen · async bus snapshot · bounded orch map · rAF-coalescer test · audit-log SQL test · dead branch) |
| `a0af43d` | PR10 | #15 (tsx → runtime dep — prune prerequisite) |
| `1343b05` | PR11 | #39 #52 (73 verified-dead i18n keys removed, both locales — exhaustive per-key sweep) |
| `164aa7f` | PR12 | #41 (per-ApiClient providers/mode cache — no per-remount refetch, invalidated on key change) |
| `2660e5f` | PR14 | #25 (Docker dev/build-toolchain prune in the builder — **638MB → 440MB, −198MB**, boot-smoke verified) |
| `7fbcdb2` | PR15 | #28 (token-quota mechanism marked shipped + AKIS_USER_TOKEN_BUDGET/_PERIOD documented) |

**Not a defect:**
- **#53 — onReset `{head}`: WORKING-AS-INTENDED.** `useLiveSession` + the client test use the `head`; `useLiveChat`'s full-`/log` re-sync is a valid simpler choice, not dead code. No change needed.

**Owner-gated / live-gated (2 — genuinely require the owner; NOT a code gap).** The MCP servers are the OFFICIAL vendor services (GitHub `ghcr.io/github/github-mcp-server` + Remote `api.githubcopilot.com/mcp/`; Atlassian Rovo `mcp.atlassian.com/v1/mcp/authv2`), so connecting REQUIRES the owner's browser OAuth consent — it cannot be CI-proven or done without the owner's account:
- **#9 #31 — live tool-NAME/payload pinning** against a real `listTools()` (the read allow-list ships + is fail-closed; the bridge's discovery diagnostic surfaces the real names on first connect).
- **#17 live half — agent auto-use wiring** of the Atlassian read tools (the read foundation ships in PR7; the live transport resolver + the "when should an agent pull Jira/Confluence context" trigger are an owner connection + a product decision). **#32 #45 live half** — the external-write flow's live end-to-end (propose→confirm→execute against a real Atlassian site).

## Cross-cutting themes

- The external-write / real-MCP batch is shipped+LIVE structurally but is the single weakest seam in the product: a dead browser call (missing content-type), a wrong Confluence tool name, a double-write-on-conflict bug, an English-only human-confirm prompt, an over-claiming signed attestation, and zero owner-scope/persistence regression tests all cluster on this one path. It needs a focused 'make MCP actually work and stay guarded' sprint before it can be called done.
- Drift is overwhelmingly in DOCS, not code — and it cuts both ways. The canonical narrative (README/ARCHITECTURE/THREAT-MODEL/NEXT.md) under-claims (the whole MCP batch, the external-write 5th gate, the golden-eval gate, the shipped quota mechanism are all unmentioned or marked unbuilt) while a couple of product ACs over-claim (full-stack-proven-by-CI). Cheapest high-trust win: reconcile the docs to the shipped tree in one pass.
- Verification HONESTY is sound at the gate (a demo pass is a real, correctly-labeled mock pass — never a false-green) but degrades at the LEGIBILITY edges: the signed handable attestation (P1) and the inline chat bubbles (P2) drop the 'simulated' marker that the Trust Report and /health badge correctly carry. Separately, the verifier has a real false-RED (bodyContains on SPAs) that can block a correct app from ever verifying — fail-closed but product-blocking.
- The single biggest ops/DX gap is institutional knowledge living only in project memory: the actual cross-arch buildx → save | ssh load → compose-up production deploy (with its hollow-image footgun and mem_limit caps) is uncodified, the committed compose has no resource/log limits, the release image is silently amd64-only against an ARM self-host target, and CI is billing-blocked with no documented local gate. The deploy works for the maintainer but is undocumented and fragile for anyone else.
- Owner-scoping is applied almost everywhere via one accessibleSession pattern, but two surfaces escaped it: the preview routes (a real IDOR letting a non-owner boot/stop/reach another user's code-running preview) and anonymous sessions (public-by-UUID). Both are the same fix shape already used elsewhere and neither is a gate-mint bypass.
- A recurring test-coverage smell: the strongest gate logic is well-tested, but the NEWEST gate-adjacent surface (the externalWrites jsonb-array column, the external-write HTTP routes, the migration ALTER) has the array-vs-json persistence bug class, no cross-user/401 test, and no migration assertion — mutation testing confirmed several would silently break green. Tests guard the moat well but lag the most recently shipped persistence + owner-scoping.
- i18n is structurally healthy (perfect 694/694 EN/TR key parity, tsc-enforced) but the NEW MCP UI leaks hardcoded English exactly where it matters most — the human-confirm gate prompt and the connect-tile blurbs — plus a large dead-key cluster the parity test cannot detect. The TR+EN contract holds for old surfaces but was not extended to the newest one.

## Prioritized backlog

### P1

**#1 [P1/S] ✅ CLOSED (1bc133d) — MCP external-write (Jira/Confluence publish) is dead in the browser — POST body sent without content-type**

- **Where:** `frontend/src/api/client.ts:271,275 (proposeExternalWrite / confirmExternalWrite)` (frontend-studio)
- **Why:** The two external-write POSTs are the ONLY body-carrying calls in the entire client that omit headers:{'content-type':'application/json'}. A browser fetch with a string body defaults to text/plain;charset=UTF-8; the main Fastify app has no global content-type parser, so req.body stays a raw STRING — b.action is undefined -> propose 400 'BadAction', and confirm mints with digest '' -> mismatch -> write recorded 'failed'. The whole recently-shipped+LIVE human-confirm publish flow is non-functional from the actual UI. Invisible to tests: the route contract test uses Fastify inject (auto-sets the JSON header) and the component test fully mocks the ApiClient.
- **Fix:** Add headers:{'content-type':'application/json'} to both proposeExternalWrite and confirmExternalWrite, matching every other POST in the client. Pin with a client.test.ts that spies fetchFn and asserts the captured RequestInit headers contain application/json for these two routes. Repairs the gate flow — does not weaken the external-write gate.

**#2 [P1/M] ✅ CLOSED (1bc133d) — Preview routes are not owner-scoped (IDOR: boot/stop/reach another user's code-running preview)**

- **Where:** `backend/src/api/preview.routes.ts:99-117 (POST/GET/DELETE /sessions/:id/preview) + /preview/:id/* proxy:129 + WS upgrade:171; registration server.ts:487` (security)
- **Why:** Every other session-touching route resolves ownership via accessibleSession (404 for non-owner); the preview routes do a bare store.get/registry.get/registry.stop with NO owner check. PreviewDeps has no userIdOf, and server.ts:487 registers {registry,store,bus} only, while a userIdOf closure already exists (server.ts:454). The global onRequest hook is CSRF-origin only. So any caller who knows a session id can boot-and-RUN another user's generated code, DELETE-stop another owner's live preview (DoS), and GET/WS-reach the running app. Only mitigation is randomUUID session ids (not enumerable).
- **Fix:** Thread the existing userIdOf closure into PreviewDeps and apply the accessibleSession 404-pattern in POST/GET/DELETE /sessions/:id/preview, exactly as /log and /events do; gate the /preview/:id/* proxy and the WS upgrade behind the same ownership resolution. Same fix shape used elsewhere; injection point at server.ts:487. Violates no sacred invariant.

**#3 [P1/M] ✅ CLOSED (1bc133d) — External-write CONFIRM persists status with a stale version -> conflict-after-execute can DOUBLE-write Jira/Confluence**

- **Where:** `backend/src/api/sessions.routes.ts:292-323 (final store.update at 319, version captured at 293)` (backend-correctness)
- **Why:** The status-recording store.update at line 319 uses s.version captured at 293 — AFTER the awaited, multi-second executeExternalWrite network round-trip — and is OUTSIDE the inner try/finally so a conflict escapes uncaught. The version DOES move in that window: chatAppend (server.ts:548) writes the same session on every chat turn (the chat box is live while ExternalWriteCard renders on a done build), and a second propose bumps it too. A 'version conflict' is an unnamed Error -> mapped to HTTP 500 (not in CONFLICT_ERRORS). Net: the Jira issue/Confluence page is already CREATED upstream but the proposal stays status:'proposed', so the user re-confirms the still-'proposed' card -> a SECOND non-idempotent issue/page. No test covers this.
- **Fix:** After executeExternalWrite, re-read the session fresh and write the resolved record with a short optimistic-retry loop (mirror the chatAppend retry in server.ts:548); critically, persist the executed/failed outcome even on conflict so the proposal flips off 'proposed' and the existing rec.status!=='proposed' guard refuses a re-confirm. Add a contract test that bumps the version between propose and confirm. Gate-safe.

**#4 [P1/M] ✅ CLOSED (1bc133d) — bodyContains probe applied to vite/next SPAs falsely-REDs a healthy app -> build can never verify**

- **Where:** `backend/src/verify/bootSmoke.ts:291-303 (deriveChecks added for ALL app types) + criteria.ts:103 (emits bodyContains); probe() bootSmoke.ts:202` (verify-trust)
- **Why:** deriveChecks emits {kind:'bodyContains',path:'/',literal} for any spec quoting a static label, and runBootSmoke adds it for ALL app types — only roundTrip/auth are gated to node-service (lines 298/302), bodyContains is NOT. For a vite/next SPA the dev server serves the JS shell; the literal is JS-injected and never in the SERVED bytes -> probe 'missing literal' -> passed:false -> no VerifyToken. A correct SPA whose spec names a static heading is falsely-RED'd and can NEVER pass the gate. Fail-closed (never false-green, so no trust invariant weakened) but product-blocking. SPA case is untested.
- **Fix:** Gate bodyContains derivation/probing to app types whose served / is the rendered surface (static, node-service); for vite/next downgrade a bodyContains to a render/pathStatus probe. Derive FEWER checks for SPAs. Add a boot-smoke test with a vite file set + a static-literal spec asserting the run still passes.

**#5 [P1/S] ✅ CLOSED (1bc133d) — Signed Build Provenance Attestation over-claims "verified" on a demo/simulated run (no simulated marker)**

- **Where:** `backend/src/verify/attestation.ts:52-104 (buildAttestation / attestationMarkdown); contrast backend/src/report/trustReport.ts:64-77` (verify-trust)
- **Why:** BuildProvenanceAttestation has NO demo/simulated field; buildAttestation sets gates.verified:isVerified(s), true for a demo run (the mock runner mints a real VerifyToken), and signPassportFor signs it unconditionally. attestationMarkdown renders 'Independently verified — a real >=1-test pass' for a SIMULATED build. The session carries the honesty signal (testEvidence.demo) and the Trust Report consumes it, but the attestation — the explicitly-named handable, SIGNED client artifact (Move 3) — ignores it.
- **Fix:** Thread simulated = s.testEvidence?.demo === true into BuildProvenanceAttestation (a simulated boolean on verification, gate gates.verified to isVerified(s) && !simulated) and render a SIMULATED banner in attestationMarkdown exactly as renderTrustReportMarkdown does. Keep what the passport SIGNS demo-blind (no gate change). Gate-safe.

**#6 [P1/S] ✅ CLOSED (1bc133d) — External-write HTTP routes (real outward side effects) have no owner-scope / cross-user / 401 test**

- **Where:** `backend/test/contract/external-writes.routes.test.ts:21,36 (guard: sessions.routes.ts:131-136,259-324)` (tests-coverage)
- **Why:** The confirm route is the ONLY path that creates a Jira/Confluence page/issue, executed through the REQUESTER's per-provider MCP transport. Owner-scope rests on accessibleSession, but the contract test always resolves one owner (opts.owner never set to a second value), never proposes/confirms as a different user, and never tests an unauthenticated request. Contrast publish.routes.test.ts which has explicit cross-user isolation. A regression letting user B confirm user A's proposal (executing a write through B's Atlassian account) would pass green.
- **Fix:** Add to external-writes.routes.test.ts: (a) propose under owner A then GET/POST/confirm as owner B -> 404 (accessibleSession null); (b) confirm with userIdOf->undefined -> 401. Both fail if the accessibleSession guard or the 401 check were removed.

**#7 [P1/S] ✅ CLOSED (1bc133d) — README.md What's-built omits the shipped+LIVE MCP / external-write / Scribe-docs batch**

- **Where:** `README.md:22-41` (spec-drift)
- **Why:** grep over README.md for MCP|jira|confluence|external-write|scribe-doc|atlassian returns ZERO body matches, yet the code is shipped+reachable+LIVE: mcpConnect.routes.ts (registered server.ts:516), externalWriteGate.ts mintApprovedExternalWrite, ScribeAgent.ts:192 writeDocs (wired Orchestrator.ts:411), FE McpConnections.tsx + ExternalWriteCard.tsx:453. README is the canonical 'what's built' surface and an entire shipped batch is invisible there.
- **Fix:** Add What's-built rows for real-MCP connect (Jira/Confluence/GitHub browser-OAuth/DCR), the external-write propose->confirm->execute gate, and Scribe README docs. Doc-only/additive — weakens no gate.

**#8 [P1/M] ✅ CLOSED (1bc133d) — External-write human-confirm summary is hardcoded English (the sacred-gate confirm prompt)**

- **Where:** `frontend/src/components/ExternalWriteCard.tsx:44-46, 99, 122` (i18n)
- **Why:** The summary the user reads BEFORE authorizing an outward write is built client-side English-only ('Create Confluence page ... in ...' / 'Create Jira issue ...'), echoed verbatim by the server (sessions.routes.ts:273) and rendered raw at the review/confirm step (line 99) and history (line 122). A TR user confirming a write sees an English sentence on exactly the human-confirm gate the threat model relies on. digestExternalWrite hashes only provider/action/target/payload (NOT the summary), so localizing the displayed copy does not touch the digest binding.
- **Fix:** Add mcpwrite.summary.confluence / mcpwrite.summary.jira keys (TR+EN) and render a localized summary from the proposal's action+target, OR display a t()-built label while keeping the stored summary as the digest-bound canonical text. Do not change what the digest is computed over. Gate-safe.

### P2

**#9 [P2/S] Confluence write broken: allow-list pins createPage, real Rovo tool is createConfluencePage (+ wrong payload shape)**

- **Where:** `backend/src/gates/externalWriteGate.ts:132-135; frontend/src/components/ExternalWriteCard.tsx:45` (mcp-completeness)
- **Why:** ATLASSIAN_WRITE_ACTIONS pins createPage and executeExternalWrite calls transport.callTool('createPage'); the live Rovo server advertises createConfluencePage (Jira createJiraIssue is correct), so every Confluence write returns unknown-tool. The path is LIVE end-to-end (ChatStudio.tsx:453 -> sessions.routes.ts:292-320). Test external-write-gate.test.ts:112 freezes the wrong name. NOTE: payload shapes are also wrong (FE sends {spaceKey,title,body} but Rovo needs cloudId+spaceId), so a rename alone won't fully succeed; track not yet live-verified (Rovo MCP not enabled).
- **Fix:** Rename to createConfluencePage in the allow-list, UI and gate test; add the discovery/intersection test the gate TODO promises so name drift fails CI; align the payload shape to Rovo's contract. Strengthens the allow-list; weakens no gate.

**#10 [P2/S] ModelPicker modal: no Escape-to-close and no focus trap despite role=dialog aria-modal**

- **Where:** `frontend/src/chat/ModelPicker.tsx:45-53` (frontend-studio)
- **Why:** The picker declares role=dialog aria-modal=true but only wires backdrop-click and Cancel to onClose — no keydown Escape handler, no focus move into the dialog on open, no Tab trap, no focus restore. An aria-modal dialog that ignores Escape and lets Tab escape into inert content fails the standard modal a11y contract. HistoryMenu.tsx:20 already shows the correct Escape pattern.
- **Fix:** Add an Escape keydown listener calling onClose, move focus to the dialog/close button on open via a ref, trap Tab within the dialog (or at minimum restore focus to the ModelChip trigger on close). Mirror the HistoryMenu pattern.

**#11 [P2/S] ✅ CLOSED (1bc133d) — Inline chat VerifyBubble / DoneBubble render green "Verified" with no simulated label on a demo run**

- **Where:** `frontend/src/chat/ChatThread.tsx:150-159 (VerifyBubble) & 210-220 (DoneBubble); chatModel.ts:10,19,89-93,125` (verify-trust)
- **Why:** The wire verify event carries demo (events.ts:71, stamped TraceAgent.ts:64) but chatModel.ts maps it dropping demo; the done event has no demo field at all. VerifyBubble styles m.passed GREEN 'Verified · N tests' and DoneBubble renders 'Shipped · verified' for a demo build with no amber/simulated marker. Mitigated: the adjacent TrustLedger already amber-tags the verify step, the durable Trust Report is correct, and /health surfaces demo mode — so this is a secondary cosmetic-honesty gap, not over-claim on a durable artifact (see rank 5).
- **Fix:** Carry demo onto VerifyMsg (chatModel.ts:91) from e.demo, amber-tint VerifyBubble and append the existing trust.ledger.simulated (TR+EN already present); for DoneBubble derive simulated from the session view's tests.demo so 'Shipped · verified' is not shown unqualified on a mock run.

**#12 [P2/S] ✅ CLOSED (38958b3) — externalWrites (jsonb ARRAY column) has NO PgSessionStore round-trip parity test — the array-vs-json bug class that hit chat LIVE**

- **Where:** `backend/test/unit/session-store-parity.test.ts:28,40,66 (vs PgSessionStore.ts:73,77,217)` (tests-coverage)
- **Why:** PgSessionStore plumbs externalWrites as an array-valued jsonb column and toJson stringifies it precisely because node-pg renders a JS array as a Postgres array literal — the exact bug caught LIVE on chat. But the parity fake omits external_writes entirely and there is no round-trip test. Mutation-proven: commenting out the PATCH_COLUMNS entry passes all 24 parity + 7 route tests. externalWrites is an ADDITIVE NON-GATE column, so this is a durable-persistence coverage gap, not a gate weakening.
- **Fix:** Add external_writes to the parity fake's JSONB set, INSERT destructuring and UPDATE column loop, then add a parity test asserting an array of proposals (status proposed->executed) round-trips via PgSessionStore.get(), mirroring the existing chat array test.

**#13 [P2/S] ✅ CLOSED (38958b3) — The external_writes migration ALTER is not asserted in the migration unit test (other additive columns are)**

- **Where:** `backend/test/unit/pg-migrations.test.ts:51-60 (vs pg.ts:108,211)` (tests-coverage)
- **Why:** pg.ts defines ADD_EXTERNAL_WRITES (L108) in MIGRATIONS (L211), but pg-migrations.test.ts pins the publish ALTER with a rationale (L57) and has NO equivalent for external_writes; the integration test asserts only users/external_id + vector_chunks. Mutation-proven: removing ADD_EXTERNAL_WRITES from MIGRATIONS passes all 9 migration tests, so an upgraded pre-existing sessions table that lost this ALTER would silently drop external-write state on Postgres with no failing test.
- **Fix:** Add to pg-migrations.test.ts: assert /ALTER TABLE sessions ADD COLUMN IF NOT EXISTS external_writes jsonb/ is present plus the fresh-table DDL check for external_writes jsonb, mirroring the publish assertions.

**#14 [P2/S] ✅ CLOSED (1bc133d) — MCP connection-tile provider blurbs are hardcoded English (NEW MCP UI)**

- **Where:** `frontend/src/pages/McpConnections.tsx:8-11, 76` (i18n)
- **Why:** PROVIDERS blurbs ('Create issues + pages (you confirm each write)', 'Read repo context for grounding') are hardcoded English and rendered at line 76 with no t() wrapping (no settings.mcp.blurb.* keys exist in catalog.ts). A TR user on the headline new-MCP connect screen sees English describing exactly which external writes a connection enables.
- **Fix:** Add settings.mcp.blurb.atlassian / settings.mcp.blurb.github to both locales and render via t(); keep id as the stable server key. The label fields are proper-noun product names — reasonable to leave.

**#15 [P2/M] External-write propose+confirm persist with a possibly-stale version (moat-lens view of rank 3)**

- **Where:** `backend/src/api/sessions.routes.ts:266-282 (propose) and :292-324 (confirm)` (moat-gates)
- **Why:** Both handlers read s via accessibleSession at the top then later call store.update(...,s.version) with the version captured at read time. The propose half is benign; the confirm half is the same root cause as rank 3 (the moat-lens confirmation) — execution/persistence consistency on a non-idempotent outward side effect, narrowed but not closed by the per-writeId in-flight guard. The gate itself is unaffected (consistency, not authorization).
- **Fix:** Fixed by the same change as rank 3 (re-read fresh + optimistic-retry the status write, persisting the outcome even on conflict). Track as one fix; this entry is the cross-dimension confirmation, not separate work.

**#16 [P2/M] Build cost-analytics ($/build, SPEC 03 A) documented as schedulable but entirely unbuilt**

- **Where:** `docs/specs/03-remaining-backlog.md:9-20 + docs/specs/00-PLAN.md:37` (spec-drift)
- **Why:** SPEC 03 A wants three steps, none shipped: model on AgentMetrics (events.ts:24-28 has only usage/durationMs/toolCalls), a pricing module (grep pricing|inputPerM|outputPerM|costEstimate = 0), and ~$X.XX in Analytics (metricsFormat.ts shows tokens/duration only). The spec itself flags it owner-decision (show $ vs tokens), so it is explicitly not-yet-built by design.
- **Fix:** Build it (additive model field + dated pricing catalog + runMetrics cost aggregation) or relabel it explicitly deferred/owner-gated. Owner decision required on whether to surface dollars.

**#17 [P2/L] SPEC 01 sec5 Jira/Confluence READ-for-grounding unbuilt — only write path + GitHub-only read allow-list shipped**

- **Where:** `docs/specs/01-real-mcp-integration.md:63 + slice8 line108 vs backend/src/agent/mcp/readOnlyAllowlist.ts` (spec-drift)
- **Why:** Spec wants a per-provider read allow-list (Jira search/read, Confluence list-spaces/get-page) admitted into the agent grounding loop (slice 8); readOnlyAllowlist.ts defines ONLY GITHUB_READONLY_TOOLS (12 names), no Atlassian read list, and ScribeAgent grounding admits only github_* tools. Atlassian shipped write-only. Slice 8 unchecked is consistent with the spec's own plan, so this is genuine scope honesty: agents cannot read Jira/Confluence for grounding.
- **Fix:** Implement the Atlassian read allow-list (frozen, mutator-neutralized) + bridge into the grounding loop per sec5/slice8 keeping remote content EPHEMERAL (never RAG-ingested), OR amend SPEC 01 to scope Atlassian write-only-in-MVP.

**#18 [P2/M] ✅ CLOSED (a405f51) — THREAT-MODEL.md documents only 4 gates — omits the external-write gate (sacred 5th branded token)**

- **Where:** `THREAT-MODEL.md:1+13-19` (spec-drift)
- **Why:** Title is 'agentic core + 4 gates'; the structural-guarantee list covers only VerifyToken/ApprovalToken/ApprovedPush/TestRunResult; grep external-write is empty. externalWriteGate.ts:148-171 defines ApprovedExternalWrite as a module-private unique-symbol brand with mintApprovedExternalWrite the sole producer — a live server-minted branded gate this audit treats as a sacred constraint, unmentioned in the security-facing doc. SELF_HOSTING.md and MEMORY.md have zero MCP/Atlassian content. (Partly Phase-5-sequenced by SPEC 01 sec10.)
- **Fix:** Document external-write as the 5th branded gate (propose-only for untrusted/remote content); add MCP env/setup + the EPHEMERAL-never-RAG invariant to SELF_HOSTING.md/MEMORY.md. Doc-only.

**#19 [P2/M] ✅ CLOSED (a405f51) — ARCHITECTURE.md (accurate-not-aspirational) is stale — no MCP, no external-write gate**

- **Where:** `ARCHITECTURE.md:1-8+sec2` (spec-drift)
- **Why:** Header dated 2026-06-03, subtitle 'real, shipped architecture, accurate not aspirational'; grep MCP|jira|confluence|external-write|atlassian = ZERO. Section 2 'The 4 gates + branded tokens' never mentions external-write. The MCP batch was committed/hardened 2026-06-07, postdating the doc, so the doc genuinely lags the shipped+LIVE reality.
- **Fix:** Add an MCP-integration section (transport seam, OAuth/DCR provider, mcpTransportFor, propose->confirm->execute) and update section 2 to 4 build gates + external-write gate (5 tokens). Doc-only.

**#20 [P2/S] ✅ CLOSED (a405f51) — NEXT.md contradicts the tree: golden-eval quality gate claimed not built when it ships and passes**

- **Where:** `docs/NEXT.md:62,84,111 vs docs/roadmap.md:61,65` (spec-drift)
- **Why:** NEXT.md says the golden-eval gate is 'not built'/TODO at three places, but retrieval-golden-eval.test.ts (HIT_RATE_GATE=0.85, 26 pairs over the 20-doc golden-corpus, real vector+BM25+RRF+rerank path) exists and roadmap.md:61/65 correctly mark it shipped as the last M1 exit criterion. NEXT.md was never reconciled after the gate landed.
- **Fix:** Update NEXT.md sections 2,6 and the snapshot table to mark golden-eval DONE citing retrieval-golden-eval.test.ts. Doc-only.

**#21 [P2/M] ✅ CLOSED (a405f51) — Product-spec AC "full-stack app proven by CI boot tests" overstates CI coverage**

- **Where:** `docs/product/akis-app-builder-studio-spec.md:64 vs .github/workflows/ci.yml` (spec-drift)
- **Why:** AC #4 claims a full-stack app builds->verifies->previews->ships through the gates 'proven by CI boot tests', but CI runs only typecheck+vitest (mock), a docker build + keyless /health boot smoke, and a chromium Playwright smoke asserting ONLY the anonymous landing renders. grep AKIS_REAL_TESTS over .github/workflows = ZERO; no CI step drives a real build through the gates. NEXT.md sec7 itself concedes full browser E2E is TODO.
- **Fix:** Reword AC #4 to match reality (image-boot + landing-render smoke; full-flow E2E TODO) or add a CI job driving a real build->verify->preview cycle. Doc-fix is the cheaper honest option.

**#22 [P2/S] ✅ CLOSED (bed8815) — Confirm UI shows only summary + 16 digest chars, not the payload bytes the human authorizes**

- **Where:** `frontend/src/components/ExternalWriteCard.tsx:97-106` (mcp-completeness)
- **Why:** The review step renders only mode.summary and a 16-char digest slice; the title/body payload is bound into the digest but never shown, thinning the 'human confirms the exact bytes' intent of the external-write gate. Mitigated: the summary includes title + target key, the payload is built deterministically from the user's own build, and the digest still blocks a display->execute swap.
- **Fix:** Render the full target + payload at confirm so the human sees the exact content they authorize. Gate-safe (does not touch the digest binding).

**#23 [P2/M] Real production deploy (buildx amd64 + save|ssh load + compose up) is uncodified — only in project memory, with a hollow-image footgun**

- **Where:** `repo root (no deploy script); docs/SELF_HOSTING.md Upgrading; vs memory` (deploy-ops-dx)
- **Why:** The box runs image:akis:deploy with NO source checkout. The repeatedly-practiced deploy (docker buildx --platform linux/amd64 --provenance=false --sbom=false -o type=docker,dest=tar -> ssh docker load -> compose up) lives only in memory, including the footgun that provenance default makes --load produce a HOLLOW image. scripts/ has no deploy script and SELF_HOSTING.md documents only compose up --build / GHCR. A git pull && compose up --build on the actual box would fail — there is no source there. Biggest DX/ops gap.
- **Fix:** Add scripts/deploy-box.sh codifying the memory sequence (encode the hollow-image footgun as a comment, tag-prev for rollback, post-deploy /health probe + auto-rollback) and document it under a new SELF_HOSTING.md 'Deploying to a remote box you own' section.

**#24 [P2/S] Repo docker-compose.yml has NO resource/PID/log limits — diverges from the box's mem_limit-capped reality**

- **Where:** `docker-compose.yml (app + db services)` (deploy-ops-dx)
- **Why:** grep deploy|mem_limit|cpus|memory|pids_limit|logging|max-size over docker-compose.yml = NONE. The working box compose caps every service (app 380m/db 240m/caddy 64m) so AKIS never starves the operator's other live app on a tiny box. The shipped compose run on any small box (the documented Ollama-style target) can OOM-kill neighbors, and the missing logging cap lets json-file logs grow unbounded and fill a small disk.
- **Fix:** Port the box's caps into the committed compose: mem_limit (app ~512m / db ~256m) + pids_limit + a logging json-file max-size:10m max-file:3 block on both services, plus stop_grace_period (see rank 26).

**#25 [P2/M] Deferred Docker -190MB win: runtime image carries the ENTIRE root pnpm graph incl. the full frontend build/test toolchain**

- **Where:** `Dockerfile:66 (COPY .../app/node_modules); backend/package.json (tsx is a devDependency)` (deploy-ops-dx)
- **Why:** Dockerfile:66 copies the whole hoisted root store (494 .pnpm packages) but the runtime only runs node_modules/.bin/tsx src/main.ts, so it ships pure frontend dev tooling (vite/vitest/jsdom/playwright/rollup/esbuild x2/@testing-library). The comment correctly forbids naive pnpm install --prod (it would prune tsx, a backend devDependency, breaking the CMD) but conflates 'can't run --prod' with 'must ship everything'.
- **Fix:** Promote tsx (+ @types/node if runtime use is nil) to backend dependencies, then pnpm --filter @akis/backend deploy --prod and COPY only that pruned dir (or pnpm prune --prod after promoting tsx). Gate behind the existing keyless boot-smoke.

**#26 [P2/S] Graceful-shutdown 10s timeout races docker's default 10s stop grace — slow drain gets SIGKILLed mid-cleanup**

- **Where:** `backend/src/api/shutdown.ts:47; docker-compose.yml (no stop_grace_period)` (deploy-ops-dx)
- **Why:** installGracefulShutdown defaults timeoutMs=10_000 and server.ts passes no override, so the in-process backstop fires at exactly t=10s — the same instant as docker's default SIGTERM->SIGKILL grace. The drain is heavy (app.close -> previewRegistry.stopAll -> closeMcpPoolBestEffort with its own 5s race -> ragQueue.drain -> vectorStore.flush -> pool.end), so the collision can truncate cleanup (pool.end / orphaned-container kill).
- **Fix:** Set the in-process backstop strictly below the container grace (installGracefulShutdown({timeoutMs:8_000})) and add stop_grace_period:30s to the app service so docker gives headroom and the in-process backstop fires first (cleanly, exit 1) rather than a hard SIGKILL.

**#27 [P2/M] Release workflow is amd64-only and that constraint is invisible to anyone pulling from GHCR onto an ARM host**

- **Where:** `.github/workflows/release.yml:84-91; README.md:55 + docs/SELF_HOSTING.md Run the published image` (deploy-ops-dx)
- **Why:** release.yml builds single-arch (load:true, 'amd64 only ... arm64 intentionally out of scope') while README/SELF_HOSTING tell users to docker run ghcr.io/...:latest 'Ollama-style' with no arch caveat. Oracle free-tier's headline shape is the Ampere A1 (ARM64) and Apple Silicon dev boxes are ARM — pulling :latest there yields exec format error. The current box being amd64 masks this for the maintainer but not for self-hosters.
- **Fix:** Either build multi-arch in release.yml (platforms linux/amd64,linux/arm64 with push:true, boot-smoke on the native amd64 runner) — better fit for the self-host promise — or add a one-line arch caveat to README + SELF_HOSTING.

### P3

**#28 [P3/S] Per-user token QUOTA enforcement shipped but specs call it deferred/owner-pending**

- **Where:** `docs/specs/03-remaining-backlog.md:30 + docs/specs/00-PLAN.md:38,44 vs backend/src/usage/quota.ts + sessions.routes.ts:180` (spec-drift)
- **Why:** quota.ts (resolveQuotaPolicy/checkQuota/QuotaExceededError + env AKIS_USER_TOKEN_BUDGET/PERIOD) is wired as a fail-closed start-only pre-check at sessions.routes.ts:179-181 returning 429 QuotaExceeded, but SPEC 03 B / 00-PLAN list quota enforcement as deferred. Only the budget NUMBER is owner-pending (default 0 = unlimited); the mechanism is done. Built-but-mislabeled drift.
- **Fix:** Mark the quota mechanism done in SPEC 03 B / 00-PLAN and document AKIS_USER_TOKEN_BUDGET / AKIS_USER_TOKEN_PERIOD in SELF_HOSTING.md. Doc-only.

**#29 [P3/M] Anonymous (ownerId-less) sessions are accessible to any caller across every session route**

- **Where:** `backend/src/api/sessions.routes.ts:131-136 (accessibleSession)` (moat-gates)
- **Why:** accessibleSession returns the session to ANY caller when !s.ownerId, and POST /sessions allows unauthenticated creation, so an anonymous session is drivable/readable by any other unauthenticated request that learns its UUID. NOT a gate-mint bypass (approve still mints via the authority, push still needs a real VerifyToken) and contained because signup is CLOSED + prod is single-operator + ids are randomUUID — defense-in-depth hardening, not exploitable today.
- **Fix:** For any non-dev/multi-tenant deployment, require auth on POST /sessions or stamp a synthetic owner on anonymous sessions. At minimum document that anonymous sessions are public-by-UUID. Weakens no gate.

**#30 [P3/M] External-write confirm executes BEFORE status flips to executed — crash mid-confirm orphans the write as proposed**

- **Where:** `backend/src/api/sessions.routes.ts:308-320` (moat-gates)
- **Why:** Order is mint -> executeExternalWrite (real write) -> THEN persist status. A crash between executeExternalWrite returning and store.update persisting leaves the page/issue created upstream while AKIS records 'proposed'; the in-memory confirmingWrites guard clears on crash and the next confirm passes the status!=='proposed' guard -> re-execute -> duplicate. Same root cause as rank 3 (narrower crash-window sibling); each execution is human-confirmed + digest-bound, so the gate is not bypassed.
- **Fix:** Persist an intermediate 'executing' status (or an idempotency token) before calling executeExternalWrite so a re-confirm after a crash detects an in-doubt prior attempt. Fixing persistence ordering addresses both this and rank 3. Gate-safe.

**#31 [P3/M] issue_read / pull_request_read are read-only ONLY because the server is started with GITHUB_READ_ONLY=1 (not allowlist-independent)**

- **Where:** `backend/src/agent/mcp/readOnlyAllowlist.ts:13-23,61-64 + StdioDockerTransport.ts:73-79` (moat-gates)
- **Why:** The allowlist doc itself states these two consolidated method-dispatchers rely on GITHUB_READ_ONLY=1; buildSpawnEnv hard-codes it so today they ARE read-only, but the SP1 defense-in-depth-independent-of-the-flag promise does not fully hold for these two names. A future refactor changing the spawn env could expose a write method while passing the name-level allowlist. The primary mitigation (a unit test asserting the spawn env) ALREADY exists (StdioDockerTransport.test.ts:171).
- **Fix:** Keep the existing spawn-env-flag unit test; optionally validate the method arg of issue_read/pull_request_read at the bridge against a positive read-method set so the two dispatchers become independently read-only. Weakens no gate.

**#32 [P3/L] No Atlassian read allow-list; slice-8 agent grounding unwired (deferred)**

- **Where:** `backend/src/agent/mcp/McpToolBridge.ts:7; backend/src/api/mcpConnect.routes.ts:131` (mcp-completeness)
- **Why:** McpToolBridge is GitHub-only; mcpTransportFor is consumed only by the confirm route, never by Scribe/Proto, so agents cannot read Jira/Confluence for grounding. This is explicitly DEFERRED (spec slices 6,8 open; plan note A), not a defect, and the connect-tile blurbs do NOT over-claim. Documented status gap. Overlaps rank 17.
- **Fix:** Defer is defensible. When implemented, add a frozen ATLASSIAN_READONLY list, parameterize the bridge, and keep remote content EPHEMERAL. Track together with rank 17.

**#33 [P3/M] OAuth callback never verifies the state param**

- **Where:** `backend/src/api/mcpConnect.routes.ts:86-104` (mcp-completeness)
- **Why:** The MCP callback takes a state param but never verifies it (userId only from the cookie), deviating from the spec (line 42, HMAC userId-bound state) and from githubConnect.routes.ts which signs/verifies one. CSRF is largely mitigated by PKCE: the code_verifier is stored per-(userId,provider) and the SDK exchanges the code against the victim's verifier, so an attacker-injected code fails PKCE — exploitability is weaker than a classic OAuth-CSRF.
- **Fix:** Add an HMAC userId-bound state and reject mismatches (mirror githubConnect), or document the PKCE binding as the intentional mitigation. Gate-neutral.

**#34 [P3/S] ✅ CLOSED (bed8815) — ExternalWriteCard 'go to Settings' is a raw <a href> -> full page reload inside the studio**

- **Where:** `frontend/src/components/ExternalWriteCard.tsx:76` (frontend-studio)
- **Why:** <a href=/settings> is a bare anchor, not the SPA Link; the app is a History-API router so this does a full document navigation, tearing down the studio React tree (AuthContext re-probe, lazy chunk re-init, providers/health/usage re-fetch, active-run live view + preview lost — only the localStorage chat thread survives) just to reach Settings. Non-blocking UX degradation.
- **Fix:** Use the router's <Link to=/settings> (the card renders within RouterProvider) so navigation is client-side and the studio isn't blown away.

**#35 [P3/S] Reopening any done build silently (re)boots the local preview every time**

- **Where:** `frontend/src/chat/ChatStudio.tsx:299-308` (frontend-studio)
- **Why:** autoRan is a single-slot ref keyed by id, so the auto-run effect re-arms whenever activeSessionId changes; opening an old finished build from History makes it active with backendStatus 'done' -> startPreview fires automatically, spinning up a preview process on every reopen even when the user only wanted to read the transcript/trust report, and even if they previously Stopped it. Reopen should restore state, not trigger side-effecting boots.
- **Fix:** Gate the auto-boot to genuinely fresh completions (only when the run just transitioned to done in the live stream), or only auto-run when there is no existing preview/publish record.

**#36 [P3/M] aria-live region wraps the whole conversation -> a streaming build floods screen readers**

- **Where:** `frontend/src/chat/AkisChat.tsx:441` (frontend-studio)
- **Why:** The scroll container sets aria-live=polite aria-relevant=additions on the ENTIRE node list including each inline RunBlock, so during a live build every newly-mounted agent bubble / tool line / status card is announced — a torrent of polite announcements. A11y noise issue, not a correctness bug.
- **Fix:** Scope the live region to just the chat reply/error rows (or set aria-live=off on the RunBlock subtree and surface a single coarse status — gate-awaiting and done — via a dedicated visually-hidden live region).

**#37 [P3/S] Hardcoded aria-labels and iframe title are untranslated (screen-reader copy)**

- **Where:** `AccountSettings.tsx:50,62,65; WorkflowBuilder.tsx:494; PreviewPanel.tsx:163` (i18n)
- **Why:** Five English literals exposed to screen readers (display name / current password / new password / require-critic-resolution / iframe title=preview) on screens that otherwise use t(). Lower impact: the three AccountSettings inputs and the checkbox already have localized visible Field/span labels (so the aria-label is redundant duplication); only the iframe title is the sole accessible name with no localized sibling.
- **Fix:** Route the iframe title through t() with a TR+EN key; drop the redundant input/checkbox aria-labels (the Field/span already labels them) or route them through the existing settings.* / workflows.* keys.

**#38 [P3/S] Untranslated English fallback strings in ExternalWriteCard**

- **Where:** `frontend/src/components/ExternalWriteCard.tsx:25, 26, 60` (i18n)
- **Why:** 'AKIS build' (default issue/page title), '# ...Generated by AKIS.' (default README), and 'done'/'failed' result fallbacks are English, surfacing only on empty-input/missing-result edge cases. Genuinely low-urgency; 'AKIS build' / 'Generated by AKIS.' arguably belong to the artifact content (brand string).
- **Fix:** Provide localized fallbacks for the result text (reuse mcpwrite.created/mcpwrite.failed); the title/README fallbacks are debatable to localize. Low priority.

**#39 [P3/M] Large dead-key cluster: retired pipeline.* namespace + other orphaned keys in both locales**

- **Where:** `frontend/src/i18n/catalog.ts (pipeline.* ~lines 30-66 + TR mirror; plus tab.build/tab.agents, trust.role.*, trust.scenario.*, trust.deploy.locked, chat.seedSpec, nav.login, roster.title, usage.unlimited, tests.empty, etc.)` (i18n)
- **Why:** The whole pipeline.* family (~40 keys/locale, except pipeline.editsBase which IS used) plus a list of confirmed-dead keys have 0 real-source references after the studio->trust-ledger redesign. The parity test only asserts equal key SETS, so it cannot catch dead keys — they bloat both locales.
- **Fix:** Remove the orphaned keys from BOTH locales (delete in pairs to preserve parity/tsc). Consider a usage-coverage lint scanning t()/tk() against catalog keys so dead keys are flagged in CI.

**#40 [P3/S] Bus snapshot persist is a synchronous full-snapshot writeFileSync on the event loop, active in production**

- **Where:** `backend/src/api/server.ts:312-327` (backend-perf)
- **Why:** persistEvents (500ms-debounced tap, prod-active) runs writeFileSync(JSON.stringify(bus.snapshot())) synchronously plus mkdirSync+chmodSync on every call. Severity is tempered: event payloads carry no code/spec blobs, the buffer is hard-capped (200x200) and LRU-evicted, the debounce DEFERS (not repeats) under load, and prod is signup-CLOSED single-user — so it's a minor event-loop nit, not a hot path.
- **Fix:** Switch to fs/promises.writeFile with a single-in-flight guard; move mkdirSync/chmodSync to boot. Low priority.

**#41 [P3/M] Per-build provider/health/usage refetch on every AkisChat remount**

- **Where:** `frontend/src/chat/AkisChat.tsx:219-242 + ChatStudio.tsx:84,146,294 (threadKey bumps)` (frontend-studio)
- **Why:** AkisChat's mount effect fetches listProviders+health+usage into its own state (discarded on unmount), and ChatStudio bumps threadKey on every new build and reopen, so each remount re-runs all three best-effort fetches with no cross-remount cache — 3 redundant requests per remount for an iterating user. All degrade gracefully; purely redundant-request cleanup.
- **Fix:** Lift providers/mode/usage into ChatStudio (or a small context) so they survive the threadKey-driven remount, or memoize them on the ApiClient. Low priority.

**#42 [P3/S] Workflow-bound Orchestrator leaks in the bound map when a run parks non-terminally and is abandoned**

- **Where:** `backend/src/api/sessions.routes.ts:123,184,326-338,368-380` (backend-correctness)
- **Why:** The per-session Orchestrator is removed from the bound map only when an action/resolve observes a TERMINAL status; a workflow-bound build that parks at awaiting_critic_resolution/awaiting_push_confirm/verify_failed/push_failed and is abandoned in the UI leaves its Orchestrator resident for the process lifetime. Bounded in practice (one object per abandoned workflow build, optional path).
- **Fix:** Evict on any terminal transition (already done) plus add a size cap / TTL sweep, or resolve the workflow binding lazily at action time from a persisted workflowId so no long-lived in-memory handle is needed.

**#43 [P3/S] When both AKIS_REAL_TESTS and a demo flag are set, the mock runner silently wins over real verification**

- **Where:** `backend/src/api/server.ts:283 & :300 -> backend/src/di/services.ts:264-270` (verify-trust)
- **Why:** server.ts:283 sets realTests:true when AKIS_REAL_TESTS is set and :300 ALSO injects createMockTestRunner when a demo flag is present; services.ts checks opts.testRunner FIRST, so the mock wins even though real was requested. Correctly labeled demo (/health mode:'demo', fatal in prod without ack), so NOT a false-green — but an operator expecting real verification gets silent simulation with no warning.
- **Fix:** Make AKIS_REAL_TESTS take precedence over the demo testRunner when both are set, or emit a startup warning that a demo flag is overriding requested real verification. Gate-safe.

**#44 [P3/S] evidenceDigest does not cover TestEvidence.demo — the passport's tamper-evidence is blind to simulated-vs-real**

- **Where:** `backend/src/verify/digest.ts:46-69 vs shared/src/session.ts:99-103` (verify-trust)
- **Why:** TestEvidence carries demo but digestEvidence omits it, so a simulated and a real run with identical counts produce an identical evidenceDigest and the signed passport carries no real/simulated signal — honesty rides only on unsigned session fields. Consistent with the deliberate demo-blind passport design, so low priority, but the durable cryptographic anchor self-describes nothing about simulation.
- **Fix:** Either include demo in digestEvidence + the passport facts (self-describing), or refuse to sign a passport for a demo run (the cleaner trust stance). Both TIGHTEN trust; gate-safe.

**#45 [P3/M] SPEC 01 sec7 partial: GitHub read grounding still uses Docker stdio + env PAT, not remote OAuth MCP**

- **Where:** `docs/specs/01-real-mcp-integration.md:81,83 vs backend/src/di/services.ts:240-257` (spec-drift)
- **Why:** Sec7 recommends remote GitHub MCP OAuth as the default reads/grounding path with Docker stdio as fallback; code routes grounding through StdioDockerTransport while remote OAuth (mcpConnect.routes.ts) is used only for the connect-tile UX, not grounding. Owner-decision-flagged soft drift.
- **Fix:** Route build-time GitHub grounding reads via mcpTransportFor (remote OAuth) per sec7, or annotate sec7 that Docker-stdio remains the MVP grounding path. Owner decision.

**#46 [P3/S] Scribe-docs shipped via a different design than SPEC 02 — the REQUIRED validator-language fix was never applied**

- **Where:** `docs/specs/02-scribe-docs.md:15-22 vs backend/src/orchestrator/Orchestrator.ts:337,411` (spec-drift)
- **Why:** SPEC 02 mandates injecting docs before validate at :336 plus a per-file-language fix at :337; code does neither (line 337 hardcodes language:'typescript' for every file; README injected later in verifyAndTransition at :411, post-critic pre-trace.run, bypassing the validator). Product goal met (README ships digest-bound through Gate 4) but the spec mechanism + REQUIRED task are stale. No behavioral defect.
- **Fix:** Update SPEC 02 to the actual injection point (post-critic, pre-verify in verifyAndTransition) and annotate the validator-language-fix task as obsoleted. Doc-only.

**#47 [P3/S] Signed compose defaults AKIS_ALLOW_DEMO_IN_PROD=1 — fake-verification is ON out of the box for a production image**

- **Where:** `docker-compose.yml app environment; backend/src/api/server.ts:706-708` (deploy-ops-dx)
- **Why:** The bundled stack runs NODE_ENV=production AND defaults the two demo acks to 1, so a bare docker compose up boots a production-tagged server whose 'verified' output is mock-verified. INTENTIONAL and well-documented (compose comment + /health mode:'demo' + FE 'DEMO · mock-verified' chip) and it does NOT weaken the structural gates (it fakes the verifier's test result, not a capability token). Residual risk is operator-perception only.
- **Fix:** No code change required (gate integrity holds, mode surfaced honestly). Optional: when a real provider key IS present but AKIS_ALLOW_MOCK=1 still forces demo-verify, log one loud boot warning. Gate-safe.

**#48 [P3/S] OCI image labels are incomplete — missing title/description/licenses/url/documentation**

- **Where:** `Dockerfile:107-110 (LABEL block); guarded by scripts/validate-p2-artifacts.sh:62-69` (deploy-ops-dx)
- **Why:** The image stamps only revision/created/version/source; docker inspect lacks the standard discoverability/compliance keys (title, description, licenses — repo is Apache-2.0, authors, url, documentation), which GHCR renders on the package page. Pure polish.
- **Fix:** Add static LABELs: org.opencontainers.image.title=AKIS, description, licenses=Apache-2.0, url/documentation pointing at the repo + SELF_HOSTING.md; optionally extend validate-p2-artifacts.sh to assert image.licenses.

**#49 [P3/M] CI billing-block has no documented runner fallback — the deterministic gate depends entirely on GitHub-hosted minutes**

- **Where:** `.github/workflows/ci.yml (all jobs runs-on: ubuntu-latest); release.yml:48` (deploy-ops-dx)
- **Why:** Every job pins GitHub-hosted runners and project memory notes 'CI = billing block'; while billing is blocked NONE of the (correct, thorough) CI runs, so main can merge with zero automated gate — which is how a build-breaking Dockerfile COPY previously reached main. No self-hosted-runner or local pre-push alternative is wired/documented. The real fix (account billing) is owner-side; validate-p2-artifacts.sh gives a partial static gate.
- **Fix:** Document a local equivalent (scripts/ci-local.sh wrapping pnpm -C backend test, pnpm -C frontend test:coverage, validate-p2-artifacts.sh, docker build + boot-smoke) referenced in CONTRIBUTING.md as the pre-merge gate; note the self-hosted-runner option (mindful it runs untrusted PR code). Resolving billing is the real fix.

**#50 [P3/M] SSE rAF coalescer (named perf invariant) is only incidentally exercised — no test pins 'N events in one frame -> one refold'**

- **Where:** `frontend/src/chat/useLiveChat.test.ts:113,121-136` (tests-coverage)
- **Why:** useLiveChat coalesces onEvent into one refold per requestAnimationFrame, but no test counts refolds/setStates/renders or fires N synchronous events asserting exactly one fold — a regression to per-event setState (reintroducing the whole-studio flicker) would pass every existing test (all assert final state only). Perf/anti-flicker invariant, no correctness/gate/security impact.
- **Fix:** Add a test that mocks requestAnimationFrame, fires e.g. 5 events synchronously, flushes one frame, and asserts the fold/derive ran once (spy the reducer or a render counter).

**#51 [P3/S] audit-log listBySession test is shape-only — the seq-order/bounded clauses are not asserted**

- **Where:** `backend/test/unit/audit-log.test.ts:28-32` (tests-coverage)
- **Why:** The fake SqlClient returns a hardcoded row regardless of query text and the test asserts only the mapped output, so the 'selects in seq order, bounded' guarantee in the test name is unverified — mutation-proven: dropping ORDER BY seq ASC LIMIT 2000 passes all 4 tests. The append test already inspects SQL text, so the pattern exists. Audit ledger is observability-only (holds no gate capability).
- **Fix:** Capture the query text in the fake (like the append test) and assert /ORDER BY seq/ and a bounding /LIMIT/ clause are present in listBySession's SQL.

**#52 [P3/S] Parity test guards workflows.title, a key nothing renders**

- **Where:** `frontend/src/workflows/i18n-keys.test.ts:22-25` (i18n)
- **Why:** The test pins TR/EN copy of top-level workflows.title, but the actual UI uses settings.workflows.title and docs.v2.workflows.title — the bare key is referenced ONLY by this test, giving false confidence the workflows page title is internationalized. Test-hygiene/false-confidence, not a runtime bug.
- **Fix:** Point the assertion at the key actually rendered (settings.workflows.title / docs.v2.workflows.title) or remove workflows.title with the dead-key cleanup (rank 39).

**#53 [P3/S] EventStreamClient.onReset typed-contract is dead: declared (data:{head}) but consumer ignores it and re-fetches full /log**

- **Where:** `frontend/src/live/EventStreamClient.ts:17 + useLiveChat.ts:95` (frontend-studio)
- **Why:** ConnectHandlers declares onReset?:(data:{head:number})=>void and connect() passes the parsed {head}, but the sole consumer takes no argument and does a full /log re-sync, discarding head. Functionally harmless (a full re-sync is correct, just not head-anchored) — dead typed-contract / API-surface drift. Lowest-stakes item; pure type hygiene.
- **Fix:** Either use head for a head-anchored resync, or simplify ConnectHandlers.onReset to ()=>void so the type tells the truth.

**#54 [P3/S] Dead-code conditional spread in PreviewRegistry.stop()**

- **Where:** `backend/src/preview/PreviewRegistry.ts:270` (backend-correctness)
- **Why:** ...(e.port !== undefined ? {} : {}) yields {} in BOTH branches — pure dead code that misleads a reader into thinking the port is conditionally cleared on stop (it is not). Harmless: portFor/staticDirFor both gate on status==='ready', so the retained port is never used.
- **Fix:** Delete the no-op spread. If the intent was to drop the port on a stopped entry, write it explicitly — but it is benign either way.
