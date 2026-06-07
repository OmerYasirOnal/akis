# SPEC 03 — Remaining backlog (the other items I asked you about)

Status: DRAFT · Each item: spec + plan + effort + owner-decision flags 🔶.

These are the items surfaced as options in earlier choices that were not picked then. Specs + plans below so they're ready to schedule.

---

## A. Build cost analytics ($ per build) — #18-adjacent, observability

**Goal:** a freelancer sees "this build cost ~$X.XX" — ties to the verifiability/freelancer wedge + a future paid tier.

**Why it's non-trivial (verified earlier):** `runMetrics` collapses in+out tokens into one total and carries NO model; per-step `AgentMetrics` (shared/events.ts) has `usage{inTokens,outTokens}` + duration + toolCalls but NO model. So a per-model price can't be applied today.

**Spec:**
1. Additive event field: add `model?: string` to `AgentMetrics` (shared) — the producer stamps the model it used (`buildAgentMetrics` is the single choke point; the agent knows `deps.provider`/the resolved model). Additive + optional → back-compat, gate-safe (observability only, no gate/mint impact). Run akis-gate-keeper since it touches the event schema.
2. A pricing module (FE or shared): per provider+model `{inputPerM, outputPerM}` from the known catalog (Opus $5/$25, Sonnet $3/$15, Haiku $1/$5, …), with a clearly-dated "update me" comment + a blended fallback for unknown models.
3. `runMetrics` keeps per-agent in/out + model → estimated cost = Σ(inTok·inPrice + outTok·outPrice). Show "~$X.XX (est.)" per run + aggregate in Analytics, clearly labeled an estimate (honest — a trust product must not show a fake-precise number).

**Verify:** unit tests on the pricing math + the runMetrics aggregation; a build's per-agent costs reconcile to the total. **Effort:** MED. **No creds.** 🔶 Owner: confirm we want $ shown (a drift-prone estimate) vs tokens-only.

---

## B. #18 — Managed key + free-quota + paid tier + usage analytics

**Done already (shipped):** key-source honesty (`/api/providers` → `user|shared|none`; the model picker shows "Your key"/"Shared key").

**Remaining spec:**
1. **Usage analytics** (overlaps A): per-user token usage over time, per-build cost, against a budget. The `UsageInfo`/`/api/usage` projection + `UsageMeter` already exist; extend with history + cost (after A).
2. **Free-quota enforcement** ✅ MECHANISM SHIPPED · 🔶 the NUMBER is the OWNER's business decision. The code is built + wired: `usage/quota.ts` (`resolveQuotaPolicy`/`checkQuota`/`QuotaExceededError`) runs as a fail-closed, start-only pre-check in `sessions.routes.ts` and refuses an over-budget build with `429 { code: 'QuotaExceeded', resetAt }` BEFORE any provider spend. Configured by `AKIS_USER_TOKEN_BUDGET` (integer tokens; `0`/unset ⇒ unlimited) + `AKIS_USER_TOKEN_PERIOD` (named tier or `<n>d`/`<n>h`/ms). Only the NUMBER + the over-quota PRODUCT policy (block vs degrade-to-BYO-key vs upsell) remain the owner's; the enforcement plumbing is done.
3. **Paid tier** 🔶 OWNER: pricing + a payment provider (Stripe?) — a separate, larger effort; out of scope until the free/quota policy is set.

**Effort:** usage-analytics MED (after A); quota enforcement ✅ DONE (mechanism) — only the NUMBER/policy is owner-pending; paid tier LARGE + owner-gated. **Recommendation:** do A (cost analytics ✅ shipped, PR6) → usage history; the quota MECHANISM is shipped (set `AKIS_USER_TOKEN_BUDGET` to switch it on), so only the business NUMBER + paid tier wait on the owner.

---

## C. #15 — Docker image −190MB (tsx→compiled deps + prod prune)

**Goal:** shrink the 623MB image (carries full node_modules for tsx-in-prod).

**Spec / approach (deliberate, the risky one):**
- The image runs the backend via `tsx` against TS sources → ships devDeps + full node_modules. Shrink by either: (a) `tsc` build to JS + `pnpm deploy --prod` (prune dev/unused) and run node on the built JS; or (b) keep tsx but `pnpm prune --prod`.
- **Risk (why deferred):** `import.meta.url`-based path resolution for skill prompts + gate paths can break under bundling/relocation; an esbuild single-bundle is OUT (it breaks those paths). Use prune, not bundle.
- **Verify:** a careful boot-test loop — build the slimmed image, boot the app, run a real build end-to-end (skills load, gates mint, a node-service preview boots), confirm the box still runs QRCheckApp. Only then redeploy.

**Effort:** MED, **deliberate + owner-gated** (touches the prod image; do in the worktree, boot-test before any redeploy). **No new creds.**

---

## D. Continuous GTM (owner action)

Dogfood → publish a signed Build Provenance Attestation as "this is what a provable AI build looks like" (HN/dev communities). Blurb drafted. This is the owner's to POST (their voice). Not a code task.
