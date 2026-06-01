# Design — Sub-project #3: Preview + Real-Test Environment (local-first, no sandbox)

> **Status:** design, awaiting user review.
> **Date:** 2026-06-01.
> **Scope:** materialize an agent-produced app, **run it locally** and preview it (top-right iframe), and let **Trace run REAL tests** (Playwright E2E + Cucumber/Gherkin BDD) producing live stats (built / running / passed + performance) — all behind the existing `TestRunner`/4-gate seams, with no microVM sandbox.
> **Inputs:** the 2026-06-01 preview/test research workflow + its adversarial review; sub-projects #1 (gates) and #2 (providers).

---

## 0. Locked decisions (this session)

| Topic | Decision |
|---|---|
| Executor | **Local-direct + scrubbed env.** The generated app runs directly on the user's machine, loopback, with the user's own privileges (like `create-vite` + `dev`). Hygiene, not a boundary: pnpm v10 blocks dependency lifecycle scripts, the child env is scrubbed of AI keys / key-store, ephemeral workspace, process-group kill on timeout. |
| Preview scope | **Vite/React SPA + simple Node HTTP service, local-only.** DB-needing apps = `unsupported` for now. Remote/proxied (tunnel) mode deferred — self-hosted, loopback already IS the user's machine. |
| Verification language | **Keep `verified`** (a real ≥1-test pass still latches the badge via the existing gate) **+ an explicit THREAT-MODEL note** that it ran in a non-isolated workspace and a signed-verifier process is future work. |
| Self-host | local-first "like Ollama": one repo, `fastify-static` serves the FE on one port; config/keystore/workspaces under `~/.akis`. Full packaging (Docker/compose, doctor CLI) is mostly deferred. |

These honor the owner's "no sandbox, local, show it nicely" intent; the security trade-off is stated honestly, not hidden.

## 1. Non-negotiables carried over

- The **4 gates** (#1) and **provider seam** (#2) are unchanged. The real test runner slots in **behind the existing `TestRunner` interface**; `mintVerifyToken` fail-closed, the digest binding, producer≠verifier, and the contract test stay intact.
- **Mock stays default** so the whole suite + smoke stay green with zero setup; the real runner is opt-in (config / when browsers are present).
- **The trusted parent computes the digest** over the canonical `RepoFile[]` the orchestrator passes to `runner.run`, and reads reporter files **only after the child exits** — never trusting any digest/result the child self-reports. (Same integrity stance as #1; a compromised run can forge a pass only until results are signed by a separate process — deferred.)

## 2. Architecture (new modules on the Fastify/Vite stack)

```
backend/src/preview/
  Workspace.ts        # materialize RepoFile[] → ~/.akis/workspaces/<sessionId>-<nonce>/; teardown (rm -rf)
  AppDetector.ts      # package.json → 'vite' | 'node-service' | 'static' | 'unsupported'
  Runner.ts           # install (pnpm, lifecycle-scripts blocked) → build/start on an allocated port
  PreviewRegistry.ts  # Map<sessionId,{proc,port,status,workspaceDir,createdAt}>; readiness probe; teardown
  proxy.ts            # @fastify/http-proxy mount /preview/:sessionId/* (websocket:true, dynamic getUpstream)
  ports.ts            # get-port with reserve (no get-then-bind race)
backend/src/exec/
  Sandbox.ts          # interface run(cmd,args,{cwd,env,timeoutMs}) → {code,stdout,stderr}; LocalDirectSandbox impl
                      #   scrubs AI_* / key-store env, ephemeral cwd, kills the process group on timeout
backend/src/verify/
  RealTestRunner.ts   # implements TestRunner; parent computes digest; runs Playwright + Cucumber via Sandbox;
                      #   parses reporter files AFTER exit; fail-closed on nonzero exit / anomaly / timeout
backend/src/bdd/
  featureGen.ts       # spec AC (Given/When/Then) → .feature files; one scenario per criterion
  messageStats.ts     # cucumber message NDJSON → {built, run, passed, failed, skipped} + step durations
backend/src/e2e/
  playwrightConfig.ts # generated config: baseURL = preview URL, JSON reporter
  playwrightStats.ts  # parse the Playwright JSON report → {testsRun, passed, failed, flaky, durations}
shared/src/events.ts  # + new event kinds: preview_status, test_progress, test_stats (verify event stays FROZEN)
backend/src/api/      # + preview/test SSE routes; health
frontend/             # top-right iframe preview + refresh + a test/stats dashboard (FE work; minimal here)
```

**Wiring:** `buildServices` swaps `createMockTestRunner` for `RealTestRunner` **only** when opted in (config + browsers present); otherwise mock. Four gates unchanged. The `verify` event stays frozen; rich stats ride **new** event kinds so the dashboard renders without touching the gate's source of truth.

## 3. Preview flow (local-direct)

1. Orchestrator has the verified/approved `RepoFile[]`. `Workspace.materialize(sessionId, files)` writes them to `~/.akis/workspaces/<id>-<nonce>/`.
2. `AppDetector` reads `package.json` → `vite` (has vite dep/script) / `node-service` (start script / server entry) / `static` (only index.html) / `unsupported` (e.g. needs a DB).
3. `Runner` installs deps with **pnpm (lifecycle scripts blocked)**, then starts: Vite → `vite --port <p> --strictPort --host 127.0.0.1` (HMR for free); Node → `node <entry>` with `PORT=<p>`; static → `@fastify/static`. Port from `get-port` reserve.
4. `proxy.ts` fronts every child under same-origin `/preview/:sessionId/*` (websocket:true for HMR), so the FE iframe embeds it without X-Frame-Options conflict, with a refresh button + live-reload.
5. Readiness probe polls `GET 127.0.0.1:<p>/` until 200; then emit `preview_status: ready` (the existing `preview` event carries the URL). Teardown: SIGTERM→SIGKILL the process group + rm the workspace on session end / new build / idle TTL; sweep stale workspaces on boot.

## 4. Real test flow (Trace = verifier)

`RealTestRunner.run(files)` (only Trace holds it):
1. Parent computes `digestFiles(files)` (trusted) — never the child's.
2. Start the preview (or a headless variant) for the app under test.
3. **Cucumber/BDD:** `featureGen` turns each spec acceptance criterion (Given/When/Then) into a scenario; run `cucumber-js` (v12 message formatter, NDJSON); `messageStats` extracts **built = pickles, running = test-case-started, passed/failed/skipped**, plus step durations.
4. **Playwright E2E:** generated config (baseURL = preview), JSON reporter; `playwrightStats` parses **testsRun = expected+unexpected+flaky, passed = ≥1 expected & 0 unexpected**, durations.
5. Both run **as child processes via the `Sandbox`** (scrubbed env, process-group kill, timeout); the parent reads the reporter files **only after exit**; **fail-closed** on nonzero exit / missing report / timeout.
6. Return a `TestRunResult` (the branded one from #1) — `testsRun ≥ 1 && passed` mints a `VerifyToken` exactly as today. Rich stats are emitted on `test_progress` / `test_stats` events for the dashboard.

Durations are reported as **run-time-on-this-host**, not benchmarks (research note).

## 5. Security posture (honest — no microVM)

Per the locked decision and `THREAT-MODEL.md`: **hygiene + blast-radius reduction, not a boundary.**
- **Every-OS free:** pnpm v10 blocks dependency lifecycle scripts (the dominant install-step attack), a small build allowlist; the child env is **scrubbed of AI keys + the key store path**; ephemeral workspace; **kill the process group** on timeout.
- **Residual (stated):** every layer shares the kernel; Node's permission model is not a sandbox. On macOS local mode there is effectively no isolation — accepted **only** for single-user self-hosted code, by the owner's explicit choice.
- **Sandbox seam kept** so a stronger executor (Docker `network=none`/caps-dropped, gVisor, microVM) or a separate **signed verifier** can drop in later without touching callers.

THREAT-MODEL.md gets a new section recording: the no-microVM choice + owner sign-off, the mitigations, the residual, and that a passing test in a non-isolated workspace is `verified` but not isolation-grade until a signed-verifier process lands.

## 6. Scope

**In scope (this sub-project):** Workspace + AppDetector + Runner + PreviewRegistry + proxy (readiness + teardown); `LocalDirectSandbox` (scrubbed env, caps where available, process-group kill); `RealTestRunner` (Playwright + Cucumber via Sandbox, parent digest, parse-after-exit, fail-closed); `featureGen` + `messageStats` + Playwright stats; new SSE event kinds; a `cucumber-bdd-e2e` Trace skill; adopt pnpm v10; THREAT-MODEL amendment; minimal config loader + health. FE: a minimal top-right iframe + refresh + a stats panel (or defer the polished dashboard to the FE sub-project — at minimum ship the SSE contract).

**Deferred:** tunnels / local-runner daemon (the deploy dream); microVM/gVisor (seam kept); separate signed-verifier (Ed25519); LLM self-heal loop; Firefox/WebKit/sharding/HTML report; Linux user/cgroups/netns/Bubblewrap hardening + Dockerfile/compose; Windows direct-exec; DB-backed generated apps.

## 7. Testing strategy

- **Unchanged green:** all #1/#2 tests + mock smoke stay green; the real runner is opt-in so default suite needs no browsers.
- **Unit (no browser):** AppDetector classification; featureGen (AC → scenarios); messageStats + Playwright stats parsers against captured reporter fixtures; Sandbox env-scrubbing (asserts AI_* keys absent in child env) + process-group kill on timeout; Workspace materialize/teardown; port allocation.
- **Integration (guarded, requires browsers):** materialize a tiny Vite app → start → readiness 200 → run a 1-scenario Playwright + Cucumber pass → `RealTestRunner` returns testsRun≥1/passed and a `VerifyToken` mints. Skips when browsers absent (CI-green).
- **Gate regression:** the #1 contract test passes unchanged behind the real runner (mock default).

## 8. Definition of done

- A generated Vite SPA (and a simple Node service) materializes, starts on an allocated port, previews via the same-origin proxy with refresh, and tears down cleanly.
- `RealTestRunner` (behind the existing `TestRunner`) runs Playwright + Cucumber, emits built/running/passed + durations on new SSE events, and mints a `VerifyToken` only on a real ≥1-test pass (parent-computed digest, parse-after-exit, fail-closed) — gates unchanged.
- Child processes run with scrubbed env (no AI keys), lifecycle scripts blocked, killed on timeout.
- `tsc` strict clean; default suite + mock smoke green with no browsers; guarded browser integration test passes locally.
- THREAT-MODEL amended (no-microVM posture + residual). On branch `feat/preview-test-env`; fresh-context review; must-fix closed before merge.
