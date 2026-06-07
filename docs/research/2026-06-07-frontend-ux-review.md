# AKIS Studio — Frontend UX Polish Review (2026-06-07)

Live, screenshot-driven, read-only review of the AKIS studio frontend (Vite + React, dev servers on :3000 backend / :5173 frontend). Authenticated as the existing single-user account (`publish-livetest@akis.local`, signup is closed). Browser: Brave automation profile via Playwright MCP. One short controlled real build was run end-to-end (Claude Haiku 4.5, demo-verify).

Screenshots referenced below live next to the playwright output (repo root, e.g. `ux-screens-2026-06-07/01-studio-en-light.png`). All app pages were checked in TR and EN; the app is **dark-theme only** (see Theme section).

## Summary (HIGH / MED counts by area)

| Area    | HIGH | MED | LOW |
|---------|------|-----|-----|
| i18n    | 1    | 3   | 1   |
| theme   | 0    | 0   | 1   |
| sync    | 0    | 0   | 1   |
| polish  | 0    | 2   | 2   |
| backend | 1    | 1   | 0   |

Overall the studio is in good shape: chat-to-build, live SSE streaming, inline gates, the trust ledger, the slim run header, recovery-on-failure, and TR translation coverage are all working and polished. The notable issues are a language preference that does not persist across page navigation, an unhandled 500 on the push-confirm path, and a handful of i18n/pluralization leaks.

---

## A. i18n (TR / EN)

### HIGH — Language toggle does not persist across page navigation
- Area: i18n
- Location: global header language toggle (`button[aria-label="Switch language"]`), every route.
- Evidence: Set TR on `/docs`, navigated to `/` → toggle and content reverted to EN (`htmlLang: "en"`, button reads "EN"). `localStorage` has `akis_chat_thread` and `akis_recent_builds` but **no language/locale key** — the selected language is in-memory React state only. Because the studio uses real route navigation between tabs (Studio / History / Analytics / Workflows / Settings / Docs), a Turkish user is forced back to English on every page change. Screenshots `ux-screens-2026-06-07/02-studio-tr-light.png` (TR set) → `ux-screens-2026-06-07/05-analytics-en-light.png` (reverted to EN after nav).
- Suggested fix: persist the chosen locale to `localStorage` (e.g. `akis_lang`) and hydrate it on app init, same pattern as the thread/recent-builds persistence.

### MED — Studio opening greeting stays English in TR mode
- Area: i18n
- Location: Studio empty-state, first AKIS bubble.
- Evidence: In TR mode the greeting paragraph remains `"Hi, I’m AKIS. Describe an app and my agents will plan, build, verify with real tests, and ship it — live. What should we build?"` (snapshot ref e76, screenshot `ux-screens-2026-06-07/02-studio-tr-light.png`). It is also persisted verbatim into `akis_chat_thread` in localStorage, so it survives reload in English regardless of locale.
- Suggested fix: render the greeting via `t('...')` (and store a locale-independent marker in the thread, resolving the copy at render time rather than persisting English prose).

### MED — Raw backend error text leaked into the UI, not i18n'd
- Area: i18n
- Location: inline RunBlock, push-failure line.
- Evidence: After a failed push the conversation shows `"push failed: github: request to /git/blobs failed (HTTP 404)"` (ref e261) — this stays English even in TR mode (`ux-screens-2026-06-07/14-build-pushfailed-500.png`; re-checked in TR, still English). The friendly recovery sentence beside it IS translated ("İnşa doğrulandı, ancak push başarısız oldu…"), so the contrast is jarring.
- Suggested fix: map server error `code` to a localized message; never render the raw `error` string from the API verbatim in chat.

### MED — "Publish Live Test" badge in the header is untranslated
- Area: i18n
- Location: global header, badge between the language toggle and Sign out (ref e24).
- Evidence: Reads "Publish LiveTest" in both EN and TR (e.g. `ux-screens-2026-06-07/08-settings-tr-dark.png`). This is the active app/workspace name; it appears to be user/build-derived rather than a label, so it may be acceptable — but it reads as an untranslated UI chip. Confirm whether it is data (keep) or a label (translate).
- Suggested fix: if it is a label, route through `t()`; if it is the workspace name, leave as-is but verify it is intentional.

### LOW — English count pluralization: "1 tests"
- Area: i18n
- Location: verify result line in the run block — `ChatThread.tsx:156` renders `{m.testsRun} {t('chat.tests')}`.
- Evidence: EN showed `✓ Verified · 1 tests` (ref e252, `ux-screens-2026-06-07/13-build-pushgate.png`); the same build in TR showed `✓ Doğrulandı · 1 test` (correct). Catalog: `chat.tests` is hardcoded `'tests'` (EN, line 133) vs `'test'` (TR, line 836) — neither pluralizes by count, so EN is wrong at count = 1. (Turkish correctly omits the plural after a numeral.)
- Suggested fix: use a count-aware plural for EN (`test` / `tests`); TR can stay singular.

Note (not a defect): History status labels, the model-picker dialog, Settings (profile, provider keys, GitHub delivery, publish destination, agent roster), and the entire Docs page all translate fully and well to TR. The agent role rows in Settings ("orchestrator / scribe / proto / trace / critic") stay lowercase English identifiers — arguably intentional, but inconsistent with the capitalized roster used everywhere else.

---

## B. Theme (dark / light)

### LOW — There is no theme toggle; the app is dark-only
- Area: theme
- Location: global.
- Evidence: `document.documentElement` has empty class and `data-theme: null`, yet `body` background is `rgb(5,7,13)` — the app ships a single hard dark theme with no toggle on any page (header, Settings, Docs all checked). No flash-of-wrong-theme and nothing to persist, because there is only one theme. Contrast, badges (LIVE, Connected, gate cards), code blocks in Docs, and the trust ledger all read cleanly in the dark theme (`ux-screens-2026-06-07/07-settings-en-dark.png`, `ux-screens-2026-06-07/09-docs-en-dark.png`, `ux-screens-2026-06-07/13-build-pushgate.png`).
- Suggested fix: none required for correctness. If a light theme is on the roadmap, that is a feature, not a bug. Flagged only because the review brief asked for a theme toggle that does not exist.

No contrast, invisible-border, hardcoded-color, or theme-persistence defects were found within the shipped dark theme.

---

## C. Sync / liveness

A full build ran cleanly end-to-end with correct live behavior:
- Chat streamed token-by-token; a SpecCard was detected and rendered with Edit / Copy / Download / Approve actions (`ux-screens-2026-06-07/12-build-speccard.png`).
- "Approve & Build" correctly disabled into "Workflow started" (no double-fire); URL gained `?s=<sessionId>`.
- The inline RunBlock mounted with its slim trust header, Stop button, and a live trust ledger that advanced Spec → Verified in place; agent bubbles (Proto → Critic → Trace) streamed with token/tool/time metrics; the push-confirm gate appeared only while awaiting (`ux-screens-2026-06-07/13-build-pushgate.png`). No pipeline-strip regression, no chat-in-chat.
- The preview rail showed verification stats live (Tests run 1, Result PASS).
- On the push 500, the gate stayed `awaiting`, an error line + a friendly recovery bubble with "Push failed — retry" appeared, and trust was not falsely advanced (Deploy stayed pending). Good failure handling.

App-origin console was clean on every page (0 errors / 0 warnings on Studio, History, Analytics, Workflows, Settings, Docs). The console errors initially observed (`support.atlassian.com`, React #418/#423, Sentry) all originate from a stray non-AKIS tab and are unrelated to this app.

### LOW — Duplicate startup requests (likely StrictMode double-mount)
- Area: sync
- Location: app boot / Studio.
- Evidence: network log shows paired duplicate GETs on load — `auth/me` ×2, `health` ×4, `sessions/:id/log` ×2, `api/providers` ×2, `api/usage` ×2, `sessions/mine` ×2 (all 200). Consistent with React 18 StrictMode double-invoke in dev; harmless in dev but worth confirming it does not double-fire in production builds.
- Suggested fix: verify production bundle issues each once; if so, no action.

No stale UI, no spinner-that-never-resolves, no optimistic/server divergence, and no state bleed between the reopened build and the new build were observed.

---

## D. Professional polish

### MED — Native browser `<select>` controls in Settings agent roster
- Area: polish
- Location: Settings → "Agents & Workflows", provider/model dropdowns (refs e140–e157).
- Evidence: these are default OS `<select>` elements, visually inconsistent with the custom radio-card model picker used in the Studio (`ux-screens-2026-06-07/03-model-picker-tr-light.png` vs `ux-screens-2026-06-07/07-settings-en-dark.png`). They look unstyled next to the rest of the dark UI.
- Suggested fix: restyle the selects (or reuse the custom picker component) for visual consistency.

### MED — Disabled action buttons give no affordance for *why*
- Area: polish
- Location: Settings (Save / Update password / per-provider Save all start `[disabled]`), Studio "Ask" button `[disabled]` when empty.
- Evidence: refs e48/e63/e75–e93 etc. all disabled at rest. Standard pattern, but the provider "Save" buttons sit beside "Connected" rows with empty inputs and no hint that you must paste a key first.
- Suggested fix: keep disabled, but ensure the empty-field/placeholder messaging makes the precondition obvious (most already do).

### LOW — Copy inconsistency: "Build tab" vs "Studio"
- Area: polish
- Location: Analytics empty state.
- Evidence: `"No runs yet — build something on the Build tab."` (ref e31, `ux-screens-2026-06-07/05-analytics-en-light.png`) — the nav calls that tab **Studio**, not "Build". Docs/Quickstart also say "Studio tab".
- Suggested fix: change "Build tab" → "Studio".

### LOW — Mobile (390px) is usable but the preview rail is not reachable
- Area: polish
- Location: Studio at 390×844.
- Evidence: `ux-screens-2026-06-07/11-studio-mobile-390.png` — header nav wraps to two lines (acceptable), agent roster stacks, chat bubbles and the trust ledger wrap cleanly. The right-hand live-preview rail is not shown at this width and there is no visible control to reach it, so on mobile you cannot see the running app. No hard layout breakage observed.
- Suggested fix: surface a way to toggle/peek the preview on narrow viewports (or document that the studio is desktop-first).

Favicon and document title are present and correct ("AKIS · agentic build studio"). No layout-shift/jank was observed during navigation; SpecCard and run bubbles render without flicker.

---

## E. Backend issues

### HIGH — 500 Internal Server Error on POST /sessions/:id/confirm (push-confirm gate)
- Evidence (exact): `POST http://localhost:5173/sessions/5be1f2d0-…/confirm → 500`, response body `{"error":"github: request to /git/blobs failed (HTTP 404)","code":"Internal"}`. Triggered by clicking "Confirm push" on a verified build. Root cause located: `backend/src/di/RealGitHubAdapter.ts:95` — `postJson('/git/blobs', …)` against the user's configured GitHub delivery target returns 404 (the configured `owner/name` repo/blob path does not resolve for this dev account). The adapter error propagates as an unhandled `Internal` 500.
- Why it matters: an operational/expected condition (missing or wrong GitHub target) is returned as a generic 500. The frontend recovers gracefully (gate stays awaiting, retry offered), but the user sees a raw, English, low-signal error and a 500 in the console.
- Suggested fix: catch the GitHub adapter failure in the confirm/push path and return a structured 4xx with a `code` the FE can localize (e.g. `github_target_not_found`) plus an actionable hint ("check Settings → GitHub delivery target").

### MED — GitHub adapter error string is unstructured / leaks transport detail
- Evidence: the message `github: request to /git/blobs failed (HTTP 404)` exposes an internal endpoint path and is the same string rendered verbatim in chat (see i18n MED above).
- Suggested fix: return a stable error `code` + a user-facing message; keep the raw transport detail in server logs only.

No CORS errors, no SSE errors, and no slow (>2s) endpoints were observed. `/health`, `/auth/me`, `/sessions/:id/log`, `/api/providers`, `/api/usage`, `/sessions/mine`, and the SSE event stream all returned 200 and behaved correctly; verification latched only on a genuine passing Trace run.

---

## Prioritized next dev-review-loop tasks (bounded, low-risk first)

1. **(LOW, i18n)** Fix EN count pluralization for tests — `chat.tests` → count-aware `test`/`tests`; pin with a test on the verify line. Pure catalog/render change.
2. **(LOW, polish)** Analytics empty state: "Build tab" → "Studio" copy fix (one catalog string).
3. **(MED, i18n)** Persist locale to `localStorage` and hydrate on boot so the language survives navigation — the single highest-value, contained fix; mirror the existing thread-persistence pattern.
4. **(MED, i18n)** Route the Studio greeting through `t()` and store a locale-independent thread marker instead of persisting English prose.
5. **(MED, i18n + backend)** Replace the raw push-failure error string with a localized message keyed off a server `code`; pairs with task 7.
6. **(MED, polish)** Restyle the native `<select>` controls in Settings to match the dark UI / custom picker.
7. **(HIGH, backend)** Make the confirm/push path return a structured 4xx (not a 500) when the GitHub delivery target is missing/404, with a localizable `code` and an actionable hint.
8. **(LOW, sync)** Confirm the duplicated startup requests are dev-only StrictMode double-mount and not present in the production bundle.

Deferred / out of scope (feature decisions, not defects): a light theme + theme toggle; a mobile path to the preview rail.
