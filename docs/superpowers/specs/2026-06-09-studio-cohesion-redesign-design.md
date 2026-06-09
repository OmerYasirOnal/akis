# AKIS Studio — Cohesion Redesign + Three Bug Fixes (Design)

**Date:** 2026-06-09
**Owner:** Ömer Yasir Önal
**Status:** Draft for review
**Visual reference:** `.superpowers/brainstorm/85755-1780993316/content/studio-v3.html` (companion mockup, direction "B" / integrated)

---

## 1. Why

The studio works but reads as **card-in-card layers** with a bare native scrollbar fused to the preview drawer seam, a loose composer with a confusing "CANLI" badge, and an agent roster that lies about state. Three concrete bugs and a cohesion deficit. The owner wants a **single, integrated, modern surface** (ChatGPT/Claude-grade), correct live agent states, fully-persistent conversations, and the preview/code/trust panel to look and work right — including a drag-resizable file tree — plus the heavier "verifiability-layer" differentiators (live file tree, watch-me-verify, click-to-edit).

### Goals
1. **Integrated, not layered** — conversation flows on the page; one clear surface (the composer); shared border/radius tokens.
2. **Three bugs fixed** — (a) scrollbar/seam, (b) conversation lost on return, (c) Scribe stuck "beklemede".
3. **Modern composer** — model picker *inside* the composer (anchored popover), no "CANLI" badge.
4. **Live, correct agent roster** — the currently-running agent highlighted with a caption + progress.
5. **Preview panel right** — Preview/Code/Trust tabs polished + working; **drag-resizable Code file tree**; responsive.
6. **Advanced differentiators** — live file tree, watch-me-verify Trace, click-an-element-to-edit.

### Non-goals
- Changing the 4 structural gates, their server-side minting, or owner-scoping (SACRED — every change is additive and gate-safe).
- Reworking the agent pipeline semantics, providers, or the verification engine's correctness.
- A full design-system rewrite — we standardize tokens for the studio surfaces only.

---

## 2. Verified root causes (the three bugs)

All three were root-caused from code and adversarially re-verified (high confidence).

### Bug A — scrollbar fused to the drawer seam + detached scroll
- The conversation scrolls on a deeply-nested inner box: `AkisChat.tsx:512` (`overflow-y-auto`, **no right gutter, no scrollbar styling**), inside the centered `mx-auto … px-4` wrapper (`ChatStudio.tsx:551`), inside the elevated `<section>` card (`ChatStudio.tsx:548`).
- `index.css` has **zero** scrollbar CSS → the raw OS scrollbar paints on the box's right edge, which abuts the drawer's `border-l` + teal edge-shadow (`components/PreviewDrawer.tsx:240,245`) → "yapışık" seam.
- The header (`ChatStudio.tsx:421`) and composer (`AkisChat.tsx:659/688`) sit outside the scroll box → three detached strata.

### Bug B — conversation lost on return
- On a History/deep-link reopen (URL has `?s=`), `seedRun` (`ChatStudio.tsx:165-197`) **wholesale-overwrites** the single localStorage spine (`akisThread.ts:74-76`, key `akis_chat_thread`) with `[greeting, run-marker, …server session.chat]`.
- `session.chat` **structurally cannot hold pre-build turns**: it's written only by `chatAppend` (`server.ts:568-577`, the sole writer), and only when a request carries a `sessionId` (`chat.routes.ts:352`/`:434`) — but the FE sends a `sessionId` only after a build exists (`ChatStudio.tsx:396` `buildContextSessionId = activeSessionId || undefined`). The spec-shaping conversation happens *before* the session exists.
- Net: the rich local spine is replaced by a thinner server copy → pre-build turns (and anything past `CHAT_TURNS_MAX`) vanish; restored turns are also mis-ordered (always placed after the run marker).
- Confirmed: a plain in-app nav that drops `?s=` does **not** lose history (`loadThread` restores the full spine) — only the reopen-with-`?s=` path triggers the clobber.

### Bug C — Scribe stuck "beklemede"
- `presenceOf` (`AgentRoster.tsx:22-35`) derives a role's chip **only** from a lane step with `agent === role`; with none → `idle` ("beklemede"). Only `orchestrator` has a status fallback.
- The studio **always** seeds the spec (`ChatStudio.tsx:275`), so `Orchestrator.start()` takes the seeded branch (`Orchestrator.ts:177-190`), mints the spec gate, kicks the run, and **returns without calling `scribe.run()`** (the only emitter of `agent_start/agent_end` with `agent:'scribe'`, `ScribeAgent.ts:158/164/199`). The later `scribe.writeDocs()` (`Orchestrator.ts:414`) emits **no** bus events. → no scribe step ever exists → permanent "beklemede".

---

## 3. Architecture of the redesigned surface

The studio becomes **two panes of one surface**, not a card stack:

```
┌─ app nav (existing global header) ───────────────────────────────┐
├─ slim agent sub-bar (transparent, fades into page) ──────────────┤
│   ▶ live roster (running agent highlighted + caption)   Geçmiş ▾  +Yeni
├──────────────────────────────────────────┬───────────────────────┤
│  CONVERSATION (on the page bg, no card)   │  PREVIEW PANE         │
│   · assistant = plain text                │  (sibling, gap, drag- │
│   · user = tinted offset bubble           │   resizable boundary) │
│   · structured blocks (spec/gate/trace)   │  tabs: Önizleme/Kod/  │
│   · reading measure ~70ch                 │        Güven          │
│   [sticky build-status bar while running] │  Code: tree│editor    │
│  ┌─ composer (the ONE surface) ─────────┐ │       (drag-resize)   │
│  │ textarea … [model ▾]          [↑]    │ │  metrics row          │
│  └──────────────────────────────────────┘ │                       │
└──────────────────────────────────────────┴───────────────────────┘
```

**Key principle:** the only bordered surfaces are (1) the composer, (2) the preview pane, (3) structured artifact blocks. The conversation itself is unwrapped. Shared tokens (one border width, a 4–12px radius scale, one scrollbar style) make the roster strip, panes, tabs and metrics read as one continuous surface.

---

## 4. Work items (by phase)

Each item: **what · where · interface/behavior · tests**. "Gate-safe" is asserted where backend/event code is touched.

### PHASE 1 — Cohesion + the three bugs (frontend-heavy; highest visible value)

**P1.1 Flatten the chat surface (integration)**
- *Where:* `AkisTranscript.tsx` (per-message rendering), `ChatStudio.tsx:548` (drop the elevated section card), `AkisChat.tsx:509-512`.
- *Behavior:* assistant turns render as plain text on the page (no per-message border/box); only **user** turns keep a tinted, offset bubble; structured artifacts (spec card, gate card, run blocks, trace) stay as blocks; cap the reading measure (~70ch / `max-w-[70ch]`). Remove the `bg-slate-900/60` card wrapper so the conversation sits on the page.
- *Tests:* component test asserting assistant message has no border/bg class and user message does; snapshot of the un-carded transcript; existing AkisTranscript tests updated.

**P1.2 Themed scrollbar + gutter + seam gap (Bug A)**
- *Where:* `index.css` (new scrollbar tokens: `scrollbar-width:thin`, `scrollbar-color`, `::-webkit-scrollbar` thin themed, applied via a `.akis-scroll` utility), `AkisChat.tsx:512` (`scrollbar-gutter: stable`), `ChatStudio.tsx` (real gap between conversation and drawer; ensure the scrollbar never paints on the seam).
- *Tests:* unit/DOM check that the scroll container carries the gutter class; visual self-verify in browser (Chrome) at the seam.

**P1.3 Composer as one rounded shell + model picker inside + drop "CANLI" (composer/model-picker)**
- *Where:* `AkisChat.tsx` composer (`:659/:688`), `ModelPicker.tsx` (today `fixed inset-0` modal → anchored popover), `ModelChip.tsx` (drop the `live/demo` badge; keep "no key" surfaced *inside* the picker), `UsageMeter.tsx` (fold into the shell footer).
- *Behavior:* one rounded container holds the textarea + a footer row with the model chip (opens an anchored popover, same provider+effort content + `saveModelPref`, reuse the focus-trap) on the left and the send button on the right edge; max-width matched to the conversation column. No status badge next to the model name.
- *Tests:* ModelPicker popover open/close + selection persistence (reuse existing tests, adapt from modal to popover); ModelChip test asserting no `live` pill; composer renders model + send in one container.

**P1.4 State persistence — merge, don't clobber + persist pre-build chat (Bug B)**
- *Where:* `ChatStudio.tsx` `seedRun` (`:165-197`), `akisThread.ts` (add a merge helper), `api.startSession` call (`:275`), backend `sessions.routes.ts` startSession + `server.ts` session creation (seed `chat` from the client-supplied pre-build conversation).
- *Behavior:*
  - **FE merge:** `seedRun` no longer overwrites. It reconciles: if the local spine already contains this session's run-marker + turns, keep the local spine (it's the richest, includes pre-build turns) and only *fill in* from `session.chat` when local is empty (different device / cleared storage). New `mergeSpine(local, serverChat, runMarker)` helper with deterministic ordering: pre-build turns → run marker → post-build turns; dedupe by `(role, content)`.
  - **BE seed (cross-device):** at build start, the FE sends the pre-build conversation; `startSession` seeds `session.chat` with it (bounded by `CHAT_TURNS_MAX`) so a reopen on another device still shows the spec-shaping turns. **Gate-safe:** `chat` is a non-gate column written through the existing generic patch; mints nothing.
- *Tests:* `mergeSpine` unit tests (local-richer, server-richer, empty-local, dedupe, ordering); a regression test reproducing "reopen with `?s=` drops pre-build turns" → green after merge; backend test that startSession seeds `chat` and it round-trips through `getSession`.

**P1.5 Scribe status correct (Bug C)**
- *Where:* backend `Orchestrator.ts:177-190` (seeded branch) — emit a **synthetic** `agent_start`+`agent_end` pair with `agent:'scribe'` (the spec was authored via chat; record that Scribe's stage is satisfied) **before** `kickRun()`; FE defense-in-depth in `presenceOf` (`AgentRoster.tsx`) — when no scribe step exists but `view.gates.specApproval?.state === 'satisfied'` (folded at `viewModel.ts:81-83`), treat scribe as `done`.
- *Gate-safety:* the synthetic emit writes **only** bus events (no `mintSpecApproval` change, no capability token, no gate mint). Reviewed by `akis-gate-keeper`.
- *Tests:* backend test asserting the seeded path emits exactly one scribe `agent_start`+`agent_end` (and still mints the spec gate exactly once, unchanged); FE `presenceOf` test: no scribe step + satisfied spec gate ⇒ `done`; ensure non-seeded path unchanged.

**P1.6 Agent roster: live + correct + active highlight + caption + progress (agent-state)**
- *Where:* `AgentRoster.tsx`, a new slim build-status element, `ChatStudio.tsx` header.
- *Behavior:* highlight the currently-running agent (ring/glow + a short live caption like "kod yazıyor…"), collapse done agents to a quiet "tamam"; add an overall "Building · Proto · 3/5 · 02:14" summary (reuse the `StartingElapsed` ticker-leaf pattern so only the badge re-renders).
- *Tests:* `presenceOf` already tested; add tests for the active-agent selection (most-recent working step) and the progress summary formatting.

**P1.7 Sticky "build running" status bar (agent-state, extra)**
- *Where:* `ChatStudio.tsx` (top of the conversation column), driven by `inFlight` from `RunPipeline`.
- *Behavior:* a thin sticky bar (active agent + phase + elapsed + Stop) while a run is in-flight, so a scrolled-away activity never reads as "frozen".
- *Tests:* renders only while in-flight; carries Stop wired to the existing cancel.

**P1.8 Cohesion tokens + "+ Yeni sohbet" anchored (integration, new-chat)**
- *Where:* `index.css` / Tailwind usage across `AgentRoster`, `PreviewDrawer`, tabs, metrics; `HistoryMenu.tsx` (+ `ChatStudio.tsx:425`).
- *Behavior:* one border width + a 4–12px radius scale + shared surface bg tokens; anchor "+ Yeni sohbet" at the top of the History rail (compose icon + label), always available (not only once a run exists).
- *Tests:* HistoryMenu shows New-chat at top; new-chat still cancels an in-flight run (`ChatStudio.newChat`).

**P1.9 Mobile-first responsive — FIRST-CLASS (responsive) — [owner-emphasized: liked mockup direction "C"]**
- *Where:* `ChatStudio.tsx`, `PreviewDrawer.tsx`, `HistoryMenu.tsx`, `AgentRoster.tsx`.
- *Behavior (designed from 320px up — mobile is a first-class target, not an afterthought):*
  - Conversation goes full-width; the composer stays bottom-pinned and full-width with the model picker + send inside its shell.
  - The agent roster becomes a **horizontally-scrollable strip** with the active agent surfaced/highlighted; History + "+ Yeni sohbet" collapse into a menu button / overlay.
  - The preview becomes a **draggable bottom-sheet with snap points** — **peek** (grip + tabs visible), **half**, **full** — drag the grip to expand/collapse. This is the mobile equivalent of the desktop drag-resize, satisfying the owner's "mobilde de genişletilebilmeli". Önizleme/Kod/Güven tabs + the metrics row stay usable at every snap; `overscroll-behavior: contain` + body scroll-lock while the sheet owns the screen (already present for the overlay); persist the last snap.
  - 320px floor; no wasted side margins; no horizontal scroll.
- *Tests:* verify at 320/375/768/1024 via device emulation; bottom-sheet snap-point drag (peek/half/full) updates height + persists; tabs reachable at each snap; assert no horizontal overflow; reduced-motion snaps instantly.

### PHASE 2 — Preview/Code/Trust polish + medium extras

**P2.1 Tabs tightened + header action cluster (tabs)**
- *Where:* `PreviewPanel.tsx`, `PreviewDrawer.tsx`.
- *Behavior:* keep the existing tab-honesty (Code shows once files exist, Trust once evidence exists, stale-tab auto-recovers to Preview); tighten the segmented control to the new radius scale; cluster the ship/inspect actions (pop-out ↗, refresh ↻, copy-URL) in a top-right header cluster; label Code with its language.
- *Tests:* existing PreviewPanel tests preserved; tab honesty unchanged; action cluster renders.

**P2.2 Code tab file-tree drag-resizable (resizable-tree)**
- *Where:* `CodeBrowser.tsx` (replace `grid-cols-[minmax(13rem,26%)_1fr]` with a draggable vertical splitter), reuse `useResizable.ts` (pointer-capture + rAF + persisted ratio) already proven on the chat↔drawer seam.
- *Behavior:* drag the tree↔editor divider; clamp to a sane min/max; persist width to localStorage; editor re-flows to fill (avoid empty-margin bug).
- *Tests:* `useResizable` reused (already tested); CodeBrowser test for the splitter + clamp + persisted width; keyboard-resize parity (arrow keys) like the drawer splitter.

**P2.3 Run/version history stepper (tabs, extra)**
- *Where:* `PreviewDrawer.tsx` header, ties to existing multi-run sessions + the Trust tab.
- *Behavior:* each gated build run is a navigable "version" (back/forward stepper); selecting one points the Trust/Code/Preview at that run. Uses the existing per-run snapshots; no new gate authority.
- *Tests:* stepper lists runs in order; selecting a run updates the active view; no cross-run state bleed (mirrors the existing reset discipline).

**P2.4 Device drag-to-resize + px readout (responsive, extra)**
- *Where:* `DeviceFrame.tsx` / device toggle in `PreviewPanel.tsx`.
- *Behavior:* alongside the named presets, a fluid drag-to-resize logical width with a live px label.
- *Tests:* width updates the iframe logical width only (no sandbox/src change); px readout matches.

### PHASE 3 — Advanced differentiators (backend-touching; gate-safe, additive)

**P3.1 Live file tree populating during the build (agent-state, advanced)**
- *Where:* backend events (emit incremental file snapshots as Proto writes), `viewModel.ts` (fold partial files), `CodeBrowser.tsx` (show files as they land).
- *Behavior:* the Code tab's tree grows live during a run instead of only after `done`.
- *Gate-safety:* a new **read-only** event kind carrying file *names/sizes* (and optionally contents) — never a gate event; mints nothing; owner-scoped via the existing stream. Reviewed by `akis-gate-keeper` + `akis-engine`.
- *Tests:* backend emits incremental snapshots; FE renders partial tree; no effect on gate events; final state equals today's.

**P3.2 Watch-me-verify — live Trace run in the Trust/Preview tab (new idea, advanced)**
- *Where:* backend Trace (`backend/src/verify/…`) streams/records the Playwright/Cucumber run; FE Trust/Preview tab shows the live (or recorded-playback) run.
- *Behavior:* instead of only pass/fail stats after, show the verification executing — AKIS's strongest "watch me verify, don't trust me" signal.
- *Gate-safety:* streaming/recording is observational; the fail-closed `VerifyToken` and its minting are untouched. Reviewed by `akis-verifier` + `akis-gate-keeper`.
- *Tests:* Trace still produces the same `testEvidence`/`VerifyToken`; the stream/playback is additive and degrades gracefully (absent stream ⇒ today's stats view).

**P3.3 Click-an-element-in-preview → composer change request (new idea, advanced)**
- *Where:* the preview iframe boundary (it is deliberately opaque-origin/sandboxed), a same-origin overlay or `postMessage` shim; routes a targeted "change this" into the composer (the existing chat-to-build edit loop / base-merge).
- *Behavior:* clicking an element floats a small action chip → pre-fills the composer with a targeted change request.
- *Safety:* respect the sandbox boundary; no script injection into the generated app; the overlay captures coordinates/labels, not app internals.
- *Tests:* overlay click pre-fills the composer; sandbox boundary intact; no cross-origin violation.

---

## 5. Cross-cutting concerns

- **Gate-safety (SACRED):** every backend touch (P1.5 synthetic scribe event, P3.1 file events, P3.2 trace streaming) is **observational/additive** — emits bus events or seeds the non-gate `chat` column only. No change to the 4 structural gates, their server-side minting, capability tokens, or owner-scoping. `akis-gate-keeper` reviews each backend diff before merge.
- **i18n:** every new/changed string lands in **both** TR and EN catalogs (`frontend/src/i18n/catalog.ts`); roster captions, status bar, picker, stepper, tooltips.
- **Strict TS:** no `any`, exact-optional discipline preserved.
- **Perf:** keep the SSE coalescer + the "only the active run reports up" pattern; the status-bar ticker is a leaf to avoid whole-tree re-renders.
- **Accessibility:** preserve focus-trap on the model popover; keyboard resize for both splitters; `prefers-reduced-motion` respected; sticky bar is `role=status`.

## 6. Testing & verification strategy

- **TDD** per unit (write the failing test first) — `superpowers:test-driven-development`.
- **FE:** Vitest + Testing Library; **BE:** existing test harness; full TR+EN i18n parity tests.
- **Adversarial review** before merge: `akis-reviewer` (correctness/lifecycle/perf/i18n) + `akis-gate-keeper` (moat) on any orchestrator/event/store/persistence diff.
- **Live verification** in the real app (Chrome via Playwright-MCP per the owner's new preference, or the `chrome-devtools` MCP): a dev-login + a seeded/real build to confirm the seam, persistence (open new chat → return → everything intact), Scribe "tamam", the resizable tree, and the responsive breakpoints. `superpowers:verification-before-completion` before any "done".

## 7. Phasing & deliverability

- **Phase 1** is independently shippable and resolves every stated complaint + all three bugs (the bulk of perceived value).
- **Phase 2** polishes the preview pane and adds the medium extras.
- **Phase 3** adds the backend-touching differentiators, each behind a graceful-degradation path so a partial rollout never breaks today's behavior.
- Each phase: build → `akis-reviewer` + (backend) `akis-gate-keeper` → live-verify → merge.

## 8. Decisions (resolved on review, 2026-06-09)
1. **Phasing:** keep the 3 phases; Phase 1 ships the full complaint list + all 3 bugs first. ✅
2. **Persistence (P1.4):** do **both** — FE merge **and** seed `session.chat` server-side at build start (survives reload *and* cross-device). ✅
3. **Phase 3 ordering:** live file tree → watch-me-verify → click-to-edit. ✅
4. **Mobile (P1.9):** first-class; the preview is a drag-resizable bottom-sheet (peek/half/full) — owner explicitly approved mockup direction "C". ✅
5. Owner delegated remaining detail decisions ("sen daha uygun doğru kararlarla ilerle").
