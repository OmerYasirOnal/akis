# Overnight progress — Studio preview drawer + chat-UX polish (2026-06-09)

Branch: **`feat/studio-preview-drawer`** (off `main`). **Not pushed, not merged** (per the no-push rule) — ready for your review. Live at `localhost:5173` (dev server running).

## What shipped tonight (all committed, all independently reviewed, full FE suite green at every step → 575 tests)

A complete **Codex/Claude-artifacts-style preview experience** + a real **chat surface**, frontend-only, gate-safe (whole-branch `akis-gate-keeper` verdict: **CLEAN — merge-safe**; iframe sandbox byte-for-byte intact, gates still render in the chat, SSE/fold untouched).

### Core — the resizable drawer (T1–T8)
- Preview is now a **right-side drawer**, closed by default → chat is full-width/centered; **slides in** (push-split: chat reflows left) when there's an artifact; **auto-opens on `preview.ready`** (not on `starting`); reopening a finished build does **not** auto-open (#35).
- **Resizable**: drag handle (W3C `role="separator"` + keyboard Arrow/Home/End, `aria-valuenow/min/max/valuetext`), persisted width ratio (localStorage), snap-to-collapse — zero-dep `useResizable` hook.
- **Device toggle**: Responsive · Mobile 390 · Tablet 768 · Desktop (logical iframe width so the app's media queries fire) + **rotate** (portrait↔landscape for mobile/tablet).
- **Mobile (`<lg`)**: full-screen overlay reusing `ModelPicker`'s a11y (role=dialog, Escape, focus-trap/restore, scroll-lock) + a floating FAB.
- **Double-scroll fixed**: two scroll regions (gate cards / preview) → the Kod tab has exactly one scrollbar.
- Header actions: **open running app in a new tab** (`noopener,noreferrer`) + **copy preview URL** (only when embeddable).

### Polish & perf (B1–B3, C1–C3)
- **Motion**: smooth drawer/device/tab transitions, full `prefers-reduced-motion` support, no first-frame width flash.
- **Real chat surface**: bounded reading measure + per-role-tinted/aligned bubbles (no more edge-to-edge text), tamed auto-scroll (active run header anchors to top — fixes the "kayıyor"), spec card collapses once a build starts.
- **Perf**: `memo(RunBlock)` + stabilized callbacks → SSE frames no longer re-render the whole chat spine (only the active run + rail).
- **Metrics strip**: surfaces the real scenario count; genuinely-absent metrics (P95) stay honest `—` with a tooltip.

## Design trail (also on the branch)
- Spec: `docs/superpowers/specs/2026-06-09-preview-drawer-design.md` (research → design → 3-lens adversarial review → independent fresh-review reconciliation → v1 scope).
- Plan: `docs/superpowers/plans/2026-06-09-studio-preview-drawer.md`.
- Chat-surface UX research: `docs/research/2026-06-08-studio-ux-ui-audit.md`.

## Separately staged (your earlier asks, not on this branch)
- **Analytics usage report** (token-by-model/agent donuts, daily/weekly/monthly/yearly charts, clean titles) → committed on **`feat/analytics-usage-report`**.
- The 6 reviewed **UX quick-win PRs + 74 regression tests** were merged to `main` earlier tonight.

## Deferred / optional (logged, not built)
- Optional flex-wrap safety on the device-toggle row (reviewer said current fits even at min width).
- Optional perf-regression test asserting terminal RunBlocks skip frames (the win is verified by reasoning + suite).

## To review in the morning
`git log --oneline main..feat/studio-preview-drawer` · open `localhost:5173`, start a build, watch the drawer auto-open on ready, drag-resize it, toggle devices/rotate, shrink to mobile.
