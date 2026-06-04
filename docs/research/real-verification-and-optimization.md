# Real verification + pipeline optimization — research synthesis

This synthesizes four research angles into directly-implementable decisions for AKIS. Every recommendation is grounded in the actual code (`backend/src/verify/realRun.ts`, `preview/PreviewRegistry.ts`, `orchestrator/subagents/ProtoAgent.ts`, `agent/providers/AnthropicProvider.ts`) and 2026 evidence from Replit Agent 3, Lovable, aider, Bolt, Cursor, and Anthropic docs.

---

## 1. Trace real-test harness recommendation

**Decision: harden the existing Playwright + Cucumber-against-the-booted-preview harness in `realRun.ts`. Do NOT add a new test stack.** The skeleton (Sandbox boot → `generateFeature` from acceptance criteria → `cucumber-js` NDJSON + `playwright test` JSON → structured `TestEvidence` with fail-closed minting) already matches what Replit and Lovable ship. It is under-hardened, not mis-architected.

Add three layers, in dependency order:

**(1) Readiness probe before the E2E step.** Today `realRun.ts` passes `PLAYWRIGHT_BASE_URL` but assumes the preview is already serving — a freshly-booted node-service behind the reverse proxy races. Add a dependency-free HTTP poll of `previewUrl`: TCP-connect first (signals "bound"), then ONE HTTP request accepting ANY status (404/3xx count as ready; only connection refused/reset is not-ready), exponential backoff + jitter, bounded by a ~20s wall-clock deadline, **fail-closed on timeout**. This converts "app was fine, test fired too early" false-fails into deterministic passes. (Mirrors §3's probe — share one probe util.)

**(2) A GUARANTEED-PRESENT baseline smoke spec that AKIS injects (not LLM-authored) for every app.** This is the single highest-value, lowest-cost gate and AKIS lacks it entirely. The spec:
- navigates to `previewUrl`;
- registers `page.on('pageerror', …)` (uncaught JS) + `page.on('console', m => m.type()==='error')` (console.error / failed fetches) BEFORE navigation;
- asserts a real landmark/heading exists via `getByRole` (not a blank document);
- asserts ZERO uncaught-JS / console-error / failed-request events fired.

~6 lines of listeners. This catches the dominant failure class — white screen from a runtime throw, 500 from a broken fetch, "Potemkin" UI — that an HTTP 200 probe and a naive "title is visible" assertion both miss. Critically, it means a build **can never mint a VerifyToken with a runtime-erroring page even if the LLM wrote weak Playwright specs.**

**(3) Keep `generateFeature()` driving acceptance criteria into Cucumber, and steer locators toward accessible names.** Prompt Proto and the step-definition generator to use `getByRole` with the computed accessible name (what screen readers announce). This forces Proto to emit semantic/ARIA-labeled HTML and makes selectors robust — the same test-attribute/ARIA discipline Replit explicitly prompts builders to add.

**Optional cheap pre-flight (static-HTML apps only):** parse the served HTML with `linkedom` (~250KB, ~1000x faster than jsdom) and assert expected landmark elements exist BEFORE spending a browser. **Never a substitute** for the browser tier — linkedom executes no JS, runs no handlers, fires no fetches, so it cannot catch the runtime/Potemkin failures that are the whole point. Pre-flight gate only.

**Integration with the fail-closed mint:** the baseline smoke spec and the readiness probe both feed the existing `TestEvidence` aggregation. A timed-out probe or a non-empty console/pageerror event list = no mint. Capture a post-load **screenshot as a non-gating trust-ledger artifact** for human/LLM-judge review — do NOT pixel-diff (generated UIs have no stable golden baseline; headless font rendering varies per host → flaky → dishonest mint).

**Net new runtime dependencies: effectively zero** beyond Playwright/Cucumber already wired, plus optional `linkedom`.

---

## 2. Proto multi-file emission strategy

**Decision: move Proto OFF the single-giant-JSON contract to a STREAMED, FENCED, PER-FILE format with explicit truncation handling.** This attacks both root causes at once and is the biggest reliability win available.

**Why JSON is actively harmful (empirical):** aider's controlled benchmark (133 tasks, Claude 3.5 Sonnet / GPT-4o / DeepSeek) found *every* model scored worse emitting code inside a JSON string vs. markdown fences. Two failure modes: (a) escaping errors — every quote/newline/backslash must be escaped, producing unterminated literals; (b) JSON-wrapping distracts the model so it reasons worse about code even when escaping is correct. AKIS's `{files:[{content:'…'}]}` contract is exactly this. Bolt streams a custom XML envelope with raw file bodies (no escaping tax); aider uses markdown fences; **nobody ships one giant JSON.**

**Ship, in order (each independently shippable):**

**(1) Fenced per-file format.** Change `PROTO_SYSTEM` to emit each file as a path marker (`===FILE: path/to/file===`) followed by a fenced block with RAW content. Add a parser that splits on markers/fences. Removes the escaping failure mode and lets each complete file survive even if the last is truncated.

**(2) Truncation recovery — the single biggest hole today.** `ProtoAgent.ts` makes ONE non-streaming `chat({maxTokens:16384})` call and **never reads `res.stopReason`**, though all four providers populate it (`AnthropicProvider.ts:95`, etc.). On cap-hit, `stop_reason='max_tokens'`, JSON ends mid-string, `parseAIJson` never closes the brace, `JSON.parse` throws, and `parse()` (`ProtoAgent.ts:129-130`) **silently swaps in a placeholder `index.ts` with `parsed:false` — the build "succeeds" with a stub.** Fix per Anthropic's documented pattern: on `stopReason` in `{max_tokens, MAX_TOKENS, length}`, auto-continue — re-call with `messages=[original user, {role:'assistant', content:partialText}, {role:'user', content:'Continue exactly where you left off, do not repeat.'}]`, concatenate, loop ≤3×, then parse the assembled text. The continue turn omits the full system prompt so prompt caching keeps the ~85-95% input discount. Per-file fences make mid-file truncation recoverable.

**(3) Fix the Gemini clamp.** `GeminiProvider.ts:54` does `Math.min(req.maxTokens, 8192)`, silently halving Proto's 16384 to 8192 — the exact budget the codebase's own comments say already truncated a non-trivial SPA. On Gemini, any moderate app is *guaranteed* to truncate → placeholder. Raise the cap (current Gemini models support far more), or at minimum surface the clamp so the continue-loop (step 2) kicks in.

**Defer:** SEARCH/REPLACE blocks for EDIT MODE. EDIT MODE already overlays emitted files (`mergeFiles.ts`) but re-emits FULL content — the most token-expensive, truncation-prone path. aider/Cursor show search/replace is ~3× less "lazy" here, but it adds apply-failure modes (no exact match) on weaker models. Secondary optimization, not the primary win.

**Regression test:** feed a truncated reply (`stopReason='max_tokens'` + JSON cut mid-string) and assert Proto recovers complete files. Today `subagents.test.ts:245` asserts the placeholder behavior — **it currently tests the bug.**

---

## 3. Node-service boot hardening checklist

**Ground truth:** the probe is NOT ~10s — `PreviewRegistry.ts:164-176` polls `60 × 250ms = ~15s`, HTTP GET to `/`, accepting `statusCode<500`, at a FIXED interval. It already detects early child exit (`proc.onExit`), releases port + tears down workspace on every failure path, and ring-buffers 8KB of stdout/stderr. The real gaps are interval *shape* and probe *ordering*, not budget.

- [ ] **Replace fixed-interval HTTP-200-on-`/` probe with two-phase backoff.** Phase A: poll TCP port-open on `127.0.0.1:port` (`net.connect` success = "server bound") — removes the false-negative when the app's root route isn't `/` or returns 404/redirect. Phase B: once open, ONE HTTP request accepting ANY status. Drive both with exponential backoff + jitter (~100ms × 1.5, cap ~1000ms, ±50%), bounded by a ~20s wall-clock deadline (env-overridable via existing `AKIS_PREVIEW_PROBE` knobs). Makes a 1-2s Vite/Express boot go ready on the first poll instead of waiting out 250ms steps; stops spurious "readiness probe timed out" on apps that boot fine but don't 200 on `/`. **Share this probe util with §1.**
- [ ] **Keep the existing early-exit watch** (already present, pair it with the new loop).
- [ ] **Inject `NODE_OPTIONS=--max-old-space-size=512`** (configurable) into `buildLaunchEnv` — bounds runaway heap for node/next/vite (all node) with zero new machinery. NOTE: `child_process.spawn` does NOT support `resourceLimits` (that's worker_threads/fork only) — `NODE_OPTIONS` is the portable lever.
- [ ] **Add an absolute max-lifetime SIGKILL** so a wedged preview self-reaps — use spawn's `timeout` + `killSignal:'SIGKILL'` (free, no manual timer) or a watchdog.
- [ ] **Prefer graceful SIGTERM-then-SIGKILL** on teardown (current code SIGKILLs the group immediately, leaving the port in TIME_WAIT and skipping the server's own cleanup).
- [ ] **Preserve the secret-scrub invariant** — `buildLaunchEnv` is `scrubEnv`'d (`Sandbox.ts` `SECRET_ENV` regex) so the captured stderr tail in `reason` can't leak an AI key. Don't reintroduce secrets via a shell wrapper when adding `NODE_OPTIONS`/`ulimit`.
- [ ] **Keep** `pnpm install --ignore-scripts --prefer-offline` (already correct; `--ignore-scripts` is THE supply-chain mitigation). Speed add: set a fixed `PNPM_HOME`/`store-dir` so repeated previews hit a warm content-addressed store.
- [ ] **Already strong, leave as-is:** port `:0` bind + in-process reservation + re-verify, `vite --strictPort` (fails loud), detached spawn + process-GROUP kill, `stopAll()` via `Promise.allSettled`, `reclaimWorkspaces()` nonce-sentinel sweep on boot.

**Do NOT** add container-grade isolation or chase the `--ignore-scripts`-bypass (PackageGate GHSA-wr8v-3jqh-9x36) — both are `THREAT-MODEL.md`-acknowledged residuals ("hygiene, not an isolation boundary"), out of scope for a boot/readiness pass.

---

## 4. Latency optimizations ranked by impact/effort

The pipeline (`Orchestrator.runToVerification`) is fully sequential; all four agents share ONE provider defaulting to `claude-haiku-4-5`; `AnthropicProvider.buildBody` sends `system` as a plain string with **zero `cache_control`** — no caching, no overlap, no right-sizing today.

| Rank | Lever | Effort | Impact | Action |
|---|---|---|---|---|
| **1** | **Prompt caching** | **Tiny** | **High** | In `AnthropicProvider.buildBody`, send `system: [{type:'text', text:req.system, cache_control:{type:'ephemeral'}}]` and add `cache_control:{type:'ephemeral'}` to the LAST `tools` entry. One localized change behind the `LlmProvider` seam → all 4 agents + the Proto↔Critic iterate loop benefit. **2026 measurements: ~20-40% TTFT reduction warm, ~70-90% input-token cost reduction**; 5-min TTL kept hot for free by back-to-back agent calls. |
| 2 | Model right-sizing | Medium | Medium | Stronger model for **Proto** (it authors the whole app; a re-iterate is the most expensive failure), fast/cheap for **Scribe + Critic** (bounded structured judgments; Critic emits booleans+counts, cascades hit 97% of GPT-4 accuracy at ~40% cost). Seam exists: `ChatRequest.model` + `buildBody`'s `req.model?.trim() || this.model`. Pairs with caching — a Sonnet reviewer clears the 1,024-token cache floor that Haiku's 4,096 floor may miss. |
| 3 | Gate-safe stage overlap | Medium-High | High ceiling | ONLY off the gate path. (a) **Cache pre-warm** the Proto/Critic system prefix during the human spec-approval wait so the first real call is a HIT. (b) Run Trace's env setup / dependency install **concurrently with the final Critic review** (Trace's verdict depends only on Proto's files, not Critic's text). Demands a focused gate-safety review — nothing may bypass verify/push. |
| 4 | Perceived-latency UX | Tiny | Cosmetic | Already partly shipped (persona chat streams; Proto/Scribe stream live notes via `chatWithLiveNotes`). The heavy `Proto.run` is non-streaming and a black box. Add per-stage skeleton/progress in the pre-first-token gap and surface live notes for the stages users wait on blind. Masks latency, doesn't reduce it — always-on complement. |

**Two load-bearing caching notes:** (1) injected skills are concatenated INTO the system prompt (`registry.buildSystemPrompt`); if the skill set varies call-to-call the prefix changes and the cache misses — order system as `[stable base persona] + [skills as a SEPARATE trailing block]` and breakpoint only the stable base. (2) `claude-haiku-4-5`'s minimum cacheable prefix is **4,096 tokens** — instrument the `cache_read_input_tokens`/`cache_creation_input_tokens` usage fields (adapter already parses usage) to confirm hits; if under the floor, this forces lever #2.

**Ship lever #1 first, alone.** It is the best impact-to-effort ratio by a wide margin with no orchestrator changes.

---

## 5. What to explicitly NOT do

- **Do NOT add a new test stack** for Trace. The Playwright+Cucumber-against-the-booted-preview harness is the mainstream path (Replit, Lovable) — harden `realRun.ts`, don't replace it.
- **Do NOT pixel-diff / `toHaveScreenshot`-gate** generated UIs — no stable golden baseline + per-host font rendering = flaky, which would corrupt the fail-closed mint. Screenshots = non-gating artifact only.
- **Do NOT let the no-browser tier (linkedom/jsdom) substitute for the browser tier** — it executes no JS, so it cannot catch the runtime/Potemkin failures that are the entire point. Pre-flight gate only.
- **Do NOT keep the single-giant-JSON Proto contract** — aider proved it degrades *every* model via escaping tax + reasoning distraction.
- **Do NOT leave `stopReason` unread** — silent truncation → `parsed:false` placeholder stub is AKIS's single biggest reliability hole today.
- **Do NOT downgrade Proto's model or Trace verification** for latency — a weak Proto causes extra Critic iterations that cost more wall-clock than the model saved.
- **Do NOT speculate through the human gates** (spec-approval, push-confirm) — they are intentional serialization points; overlap only off the gate path.
- **Do NOT naively cache the full request context** — it can REGRESS latency ~9%. Cache the static system/tools prefix only, never the dynamic tail (grounding/feedback/baseFiles/spec-body, already correctly in the USER message).
- **Do NOT add container isolation or chase the `--ignore-scripts` bypass** in the boot-hardening pass — `THREAT-MODEL.md`-acknowledged residuals, out of scope.
- **Do NOT rely on `spawn`'s `resourceLimits`** — it doesn't exist for `child_process` (worker_threads/fork only). Use `NODE_OPTIONS=--max-old-space-size`.