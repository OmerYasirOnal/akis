# Overnight work — Studio preview drawer + chat-UX + a11y overhaul (2026-06-09)

Branch: **`feat/studio-preview-drawer`** (off `main`). **Not pushed, not merged** (per the no-push rule) — certified merge-ready for your review. Live at `localhost:5173` (dev server running).

**Totals:** 28 commits (24 feat/fix + 4 docs), 42 files (+3020 / −310). **FE suite 599 tests green · tsc 0 · build ✓.** Every batch independently reviewed (akis-reviewer); the whole branch certified by a final **akis-gate-keeper: CLEAN — merge-safe** (diff touches only `frontend/src`; iframe sandbox / 5 gates-in-chat / SSE-fold / card guards / `AkisChat key` all byte-identical; every addition is pure view-state).

## What shipped

**The Codex/Claude-artifacts preview drawer (T1–T8)** — preview is a resizable right **drawer**, closed by default (chat full-width), slides in (push-split) and **auto-opens on `preview.ready`**; reopening a finished build does NOT auto-open (#35). Drag-resize (W3C `role=separator` + keyboard + persisted ratio + snap-collapse + double-click-reset), **device toggle** (Responsive · Mobile 390 · Tablet 768 · Desktop, logical iframe width) + **rotate**, **mobile** full-screen overlay (ModelPicker a11y), **double-scroll fixed** (one scrollbar on Kod), header actions (**open-in-new-tab** + **copy URL** + **refresh**).

**Motion & chat surface (B1–B3)** — smooth drawer/device/tab transitions + full `prefers-reduced-motion`; real chat surface (bounded, role-tinted bubbles; tamed auto-scroll; spec card collapses once a build starts); perf (`memo(RunBlock)` → SSE frames no longer re-render the whole spine).

**a11y / i18n / honesty / UX (C3, D1–D4, E1)** — metrics strip surfaces the real scenario count (honest `—` for absent P95); localized analytics status (was leaking raw enums); reduced-motion now covers spinners/pulses; SR-announced save-success; Settings loading states; CodeBrowser copy-all; HistoryMenu keyboard nav; unified page heading; cold-start chips under the greeting; **editsBase disclosure in the drawer** (honesty); **global a11y**: nav `aria-label`/`aria-current`, per-route `<h1>` + `document.title`, skip-to-content + `<main>` landmark.

## Two design choices to confirm (I didn't decide unilaterally)
1. **History heading** is now the smaller shared `SectionTitle` to match every other page (was a bigger gradient `h1`). Alternative: promote a branded page-title everywhere. Your call.
2. **Device toggle** includes Tablet 768 + rotate (I'd originally YAGNI-deferred these; re-added since you wanted thorough device-switching). Trivial to drop if unwanted.

## Verified live (Brave automation)
Drawer auto-open on ready, drag + keyboard resize, device toggle (Mobil 390 confirmed), Kod single-scroll, mobile overlay (dialog + focus-trap + scroll-lock), closed full-width chat surface, the `3/3` scenario count + header actions. Screenshots in `~/Downloads/akis-studio-redesign/`.

## Process trail (on the branch)
- Spec: `docs/superpowers/specs/2026-06-09-preview-drawer-design.md` (research → design → 3-lens adversarial review → independent fresh review → v1 scope).
- Plan: `docs/superpowers/plans/2026-06-09-studio-preview-drawer.md`.
- Chat-UX research: `docs/research/2026-06-08-studio-ux-ui-audit.md`.

## Separate (your earlier asks, NOT on this branch)
- **Analytics usage report** (token-by-model/agent donuts, daily/weekly/monthly/yearly, clean titles) → committed on **`feat/analytics-usage-report`**.
- 6 reviewed UX quick-win PRs + 74 regression tests → merged to `main` earlier tonight.

## To review
`git log --oneline main..feat/studio-preview-drawer` · open `localhost:5173`, start a build, watch the drawer auto-open, resize/toggle/rotate, shrink to mobile. Nothing is pushed/merged — yours to approve.
