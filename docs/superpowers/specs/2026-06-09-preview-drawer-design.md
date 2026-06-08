# AKIS Studio Preview Pane — Resizable Right Drawer + Device Toggle (Design Doc)

*Frontend-only. Codex/Claude-artifacts conventions, AKIS grounding, sacred constraints preserved. Date 2026-06-09.*

## 1. Summary & principles

Replace today's in-flow two-column CSS grid with a **chat-first shell + a slide-in right drawer** that holds the live preview, trust, publish, and proposal rail. Four load-bearing principles, each traceable to the research:

- **Chat-first.** The conversation is the spine and stays full-bleed and centered when no preview is showing. The drawer is a guest, never the host (Lens 1: chat is always primary; Lens 4 sacred: the chat `<section>` must keep its tree slot).
- **Closed-by-default, auto-open on first artifact.** Claude Artifacts' cleanest convention (Lens 1 §2): nothing on screen until there is something to show, then it slides in. Flip `previewOpen` to `false` and open it when the preview is *ready*.
- **Single scroll per surface.** Kill the double-scrollbar (Lens 4d) by giving the rail one scroll wrapper and letting `PreviewPanel`/`CodeBrowser` own their internal scroll.
- **Gate-safe & view-only.** Resize, device toggle, and open/close are pure view state. No gate authority, no SSE per-event setState, no iframe-sandbox change (Lens 4c).

Anti-patterns explicitly avoided: no mutually-exclusive new-tab (StackBlitz), no auto-close/reopen-on-focus churn (Cursor), no transform-scale on the mobile view itself (Lens 2), no trapping the user with no collapse affordance.

## 2. Layout shell

The studio root (`ChatStudio.tsx:402`) becomes `relative` so the drawer can be an `absolute`/`fixed` **sibling overlay**, not a grid cell. The chat `<section>` (`:428`) stays at its exact tree position (sacred) and is now **always full-width and centered** — its existing `mx-auto max-w-*` clamp does the centering. We drop the grid-template-columns swap entirely.

**Desktop (≥lg) = push-split, not pure overlay.** Per Lens 1's strongest convention (every serious builder uses a side-by-side split so both panes stay visible), on desktop the chat **reflows left** when the drawer is open: the studio root gets right padding equal to the live drawer width (`paddingRight: var(--preview-w)` via inline style), so the centered chat shifts into the remaining space instead of being covered. The drawer is `absolute right-0 top-0 h-full` with `transform: translateX(0)` open / `translateX(100%)` closed, `transition-transform duration-300 ease-out`. This gives the artifacts look (slide-in) AND the split (both visible). No backdrop scrim on desktop.

**Width model.** Drawer width is a single source of truth: a CSS custom property `--preview-w` on the studio root, fed from a `previewWidth` ratio (fraction of studio width). Default **46%** (matches today's `minmax(30rem,46%)` at `:427`). Clamp `[minPx=30rem, maxPx=min(60%, calc(100% − 28rem))]` — the `28rem` floor guarantees the chat never collapses below readable width. The chat's `paddingRight` and the drawer's `width` both read `--preview-w`, so they move in lockstep on a single style recalc (Lens 3: drive layout through one CSS variable, not React state per pointermove).

## 3. Resize

**Drag handle UX.** A 12px-wide hit-area gutter on the drawer's **left edge**, visually a 1px hairline that thickens to a 3px teal bar on hover/focus (`cursor: col-resize`, `touch-action: none`). Dragging left widens the drawer (chat shrinks), right narrows it. Disable the width `transition` during drag, re-enable for snap/open.

**A11y contract (W3C Window Splitter, Lens 3).** The handle is `role="separator"`, `tabindex={0}`, `aria-orientation="vertical"`, `aria-controls={previewDrawerId}`, `aria-label={t('preview.resize')}`. Live values: `aria-valuenow` = drawer width as 0–100 (we store the chat-pane percentage so larger = more chat; pick one and keep it consistent — we use **drawer width %**), `aria-valuemin={25}`, `aria-valuemax={60}`, updated every frame. Keyboard: **Left/End widen, Right/Home narrow** by a 5% step (clamped); **Enter toggles collapse** (collapse → restore previous width). Visible focus ring. Keyboard resize persists identically to pointer resize.

**Engineering (Lens 3).** Pointer Events + `setPointerCapture(e.pointerId)` on `pointerdown` (no global document listeners, no fast-drag breakage). Coalesce moves: store latest `clientX`, write `--preview-w` once per `requestAnimationFrame`. Clamp each frame.

**Snap-to-collapse.** Below `minPx/2` (~15rem), snap shut (`previewOpen=false`) and persist the last *open* width so re-open restores it.

**Persistence.** A `usePersistedWidth(key, default)` hook mirroring `recentBuilds.ts` (try/catch, ratio not pixels so it survives viewport changes). localStorage key **`akis_preview_drawer`** storing `{ ratio:number, open:boolean }`. Rehydrate on mount before paint to avoid layout shift. Persist final ratio on `pointerup`/keyup, not per frame.

**Custom hook vs library — recommendation: custom `useResizable` hook (~90 LOC, zero deps).** AKIS is one 2-pane horizontal split and explicitly targets a lean self-hostable bundle (Lens 3 recommendation, Lens 4 grounding). `react-resizable-panels` (the shadcn engine) earns its weight only for nested/multi-pane groups, which AKIS does not have. CSS-variable + Pointer-capture + rAF + localStorage ratio gives everything that library offers for this single case at a fraction of the bytes and zero version-churn risk.

## 4. Device toggle (mobile ↔ web)

**Control.** A segmented control (three buttons) in `PreviewPanel`'s top toolbar, next to the existing demo/verified/Run cluster (`PreviewPanel.tsx:90-112`). Each button: icon + `aria-label` + `aria-pressed`, visible focus ring, and a live **width readout badge** (e.g. "390 px") so it is never icon-only (Lens 2 a11y).

**Widths (justified from Lens 2).** Three presets + one fluid:
- **Mobile 390px** (modern iPhone; 375 still common — 390 is the safe modern default).
- **Tablet 768px** (Figma/DevTools canonical tablet breakpoint).
- **Desktop / Fit 1280px** (real desktop breakpoint).
- **Responsive (fluid)** — iframe width follows the pane; the default.

**iframe-width vs transform-scale — combined (Lens 2 best practice).** Drive the **iframe's logical width** to the preset so the app's CSS media queries fire authentically and text stays crisp (DPR owned by the iframe). Apply `transform: scale(min(1, paneInnerWidth / presetWidth))` with `transform-origin: top left` + a `ResizeObserver` **only to shrink Desktop down** into a narrow drawer — never scale Mobile/Tablet up (that muddies text and breaks pointer hit-testing). One scrollbar: the iframe scrolls; the wrapper is `overflow-hidden`.

**Composition with the drawer width + existing letterbox.** This **replaces** the fixed `max-w-[1100px]` letterbox at `PreviewPanel.tsx:164`. New rule: the iframe wrapper gets `width = min(presetWidth, paneInnerWidth)` for Mobile/Tablet (centered via `mx-auto`, dark letterbox margins preserved); Desktop/Fit uses `width = min(1280, paneInnerWidth)` and scales down if the drawer is narrower than 1280. Responsive uses `width:100%` (today's behavior, minus the 1100 cap). The `mx-auto` centering and dark surface stay — the letterbox aesthetic is kept, just device-driven.

**Rotate.** Yes — a small rotate button for Mobile/Tablet only (swaps w↔h, e.g. 390×844 ↔ 844×390). Hidden in Desktop/Responsive. Cheap, expected (DevTools/Figma), and useful for landscape checks.

**Default.** **Responsive (fluid)** so a freshly-built app fills the drawer naturally; remember last-selected device across sessions (localStorage `akis_preview_device`) — directly addresses Lovable's "users ship without ever checking phone" caveat by making the last choice sticky.

## 5. Responsive

- **Mobile (<lg).** The drawer becomes a **full-screen overlay** (`fixed inset-0`, `z-50`) with a **backdrop scrim** and a close X. The chat does not reflow (no room). A persistent floating **"pocket" handle** — a small bottom-right FAB labeled "Preview" with a verified dot — opens it; it replaces today's `lg:hidden` Chat/Preview tablist (`:406-423`) as the reachability mechanism. Resize is disabled here (full-screen); the drag handle is `lg:block hidden`.
- **Tablet/Desktop (≥lg).** Push-split per §2, resize enabled, no scrim.
- **Device toggle on small screens.** On a full-screen mobile overlay the toggle still works but defaults to/locks visual sense: Mobile and Responsive are identical (pane ≈ phone width), so we keep all three visible but the readout makes the (no-op) Mobile/Responsive equivalence honest. Tablet/Desktop presets scale-to-fit-down as on desktop.

## 6. Drawer content + double-scroll fix

The drawer holds, top to bottom: the resize handle (edge), a header row (title + collapse/close + the device segmented control travels with `PreviewPanel`), then the scroll body containing the stacked cards (`TrustReportCard`, `PublishButton`, `AgentWriteProposals`, `ExternalWriteCard`) followed by `PreviewPanel`. **Run control, TestStats, demo/verified pills stay exactly where they are** inside `PreviewPanel` (`:90-112`, `:256`) — unchanged.

**Double-scroll fix (Lens 4d, the load-bearing edit).** Change the drawer container (today `ChatStudio.tsx:439`, the `<aside overflow-y-auto>`) to **`overflow-hidden flex flex-col`**, and wrap the *stacked cards group* in a single `min-h-0 flex-1 overflow-y-auto` sub-div. `PreviewPanel` keeps `flex h-full flex-col` and `CodeBrowser` keeps its own internal scroll regions (`CodeBrowser.tsx:53/55/86`) — both already scroll correctly and need **no change**. Result: one scrollbar for the card stack, one for the code viewer when on the Code tab, never two stacked. Add `min-h-0` to `PreviewPanel`'s root so its `flex-1` children own scroll.

## 7. Auto-open / state machine

- **Default closed:** `ChatStudio.tsx:73` → `useState(false)` (rehydrated from `akis_preview_drawer.open`).
- **Auto-open on preview-ready, current run only.** The auto-preview effect (`:306-314`) boots the process but does not open the rail. Add: when the active run reaches a *previewable* state — `view.preview.url` becomes embeddable OR `view.preview.starting` flips true for the **active** session — call `setPreviewOpen(true)` once (guard with a ref keyed by sessionId so it fires once per run). This is the "auto-open the moment there's an artifact" convention, scoped to the **current** run only.
- **Reopen rule #35 honored:** a reopened past build pre-seeds `autoRan.current = id` (`:152`) and must **not** auto-open the drawer — the user may only want the transcript. So gate the auto-open on the same "not a reopen" condition (only fire when `autoRan` was set *by completion*, not by `seedRun`). Manual open via the floating trigger always works.
- **Close/reopen:** explicit X / collapse chevron sets `previewOpen=false` and persists. The collapsed 4rem strip (`:468-483`) is removed; its replacement is the persistent floating "Open preview" trigger (desktop: a slim tab on the right edge; mobile: the FAB), so the user is never trapped (anti-pattern: no collapse affordance / no reopen).
- **Persisted:** `{ratio, open}` survive refresh; device preset survives refresh.

## 8. Sacred constraints & gate-safety (untouched)

- **Iframe sandbox** `PreviewPanel.tsx:165` `sandbox="allow-scripts allow-forms allow-popups"` — **NO `allow-same-origin`**. Device toggle resizes/scales the wrapper only; never touches `sandbox`, `src`, or the `embeddable = url.startsWith('/preview/')` allowlist (`:57`).
- **Single-conversation chat spine:** `AkisChat key={threadKey}` (`:371`) and the chat `<section>` (`:428`) keep their exact tree slot. The drawer is an overlay **sibling**, never wrapping or branching the chat (would remount → discard the inline run marker).
- **5 gates render in chat** (inside `AkisChat`/`RunBlock`), not the rail — unchanged.
- **SSE/fold:** `activeView` from the single active-run reporter (`onActiveView` `:384`); no per-event setState added in the drawer. Auto-open reads the already-folded `view`, fires once.
- **Gate-safety:** `canRun` (`:326`), `runApp` (`:286`), `startBuild`, approve/confirm flows unchanged. Resize/toggle/open are pure view state; FE holds no gate authority.

## 9. Component breakdown + wiring

**New components/hooks**
- `useResizable({ minRatio, maxRatio, storageKey })` → `{ ratio, setRatio, separatorProps, isDragging }`. Pointer-capture + rAF + clamp; writes `--preview-w`; emits Window-Splitter `aria-*`.
- `usePersistedWidth` / `usePersistedDevice` → thin localStorage helpers mirroring `recentBuilds.ts` (try/catch, ratio/string).
- `PreviewDrawer` → the overlay shell: transform slide, edge `role="separator"` handle, header (title + close/collapse), scroll body. Props: `open`, `onClose`, `widthRatio`, `separatorProps`, `children`, `fullscreen` (mobile).
- `DeviceToggle` → segmented control. Props: `device`, `onChange`, `orientation` (rotate state), with `aria-pressed` + width badge.
- `DeviceFrame` → wraps the iframe: computes `width = min(preset, paneWidth)`, applies scale-to-fit-down via `ResizeObserver`, owns `transform-origin: top left`. Lives inside `PreviewPanel`, replacing the `max-w-[1100px]` div.

**Files:lines to change (from grounding)**
- `ChatStudio.tsx:73` — `previewOpen` default → `false` (rehydrate from storage).
- `ChatStudio.tsx:306-314` — add scoped, once-per-run `setPreviewOpen(true)` on preview-ready (honor #35 reopen suppression).
- `ChatStudio.tsx:402` — studio root → `relative`; add `style={{ paddingRight: previewOpen ? 'var(--preview-w)' : 0 }}` at ≥lg.
- `ChatStudio.tsx:406-423` — remove the mobile Chat/Preview tablist; replace with the floating trigger / FAB.
- `ChatStudio.tsx:427` — delete the grid-template-columns swap; chat is full-width centered.
- `ChatStudio.tsx:438-485` — replace the `<aside>` grid cell with `<PreviewDrawer>` (overlay sibling); move the rail cards + `PreviewPanel` inside it; `:439` `overflow-y-auto` → `overflow-hidden flex flex-col` + inner `min-h-0 flex-1 overflow-y-auto` card wrapper.
- `PreviewPanel.tsx:27` — add `device`/`orientation` state.
- `PreviewPanel.tsx:90-112` — add `<DeviceToggle>` to the toolbar cluster.
- `PreviewPanel.tsx:163-164` — wrap iframe in `<DeviceFrame>`; remove `max-w-[1100px]`. **Line 165 sandbox untouched.**
- `PreviewPanel.tsx:64` — root → add `min-h-0`.
- `catalog.ts` EN ~`:185` + TR ~`:953` — new keys (§10).

## 10. i18n keys (new)

Add to **both** catalogs (EN block ~185, TR block ~953). Existing reused: `preview.collapse/expand/collapsed`, `preview.run`, `preview.verified/unverified`.

| key | en | tr |
|---|---|---|
| `preview.open` | Open preview | Önizlemeyi aç |
| `preview.close` | Close preview | Önizlemeyi kapat |
| `preview.resize` | Resize preview panel | Önizleme panelini yeniden boyutlandır |
| `preview.device.label` | Device | Cihaz |
| `preview.device.mobile` | Mobile | Mobil |
| `preview.device.tablet` | Tablet | Tablet |
| `preview.device.desktop` | Desktop | Masaüstü |
| `preview.device.responsive` | Responsive | Duyarlı |
| `preview.device.rotate` | Rotate | Döndür |
| `preview.device.width` | {n} px | {n} px |

## 11. Test plan

**Component (vitest + RTL):**
- Drawer closed-by-default; opens on simulated preview-ready (active run only); does NOT open on a reopened build (#35 — `autoRan` pre-seeded).
- Resize: pointerdown→move→up updates `--preview-w` and persists ratio to `akis_preview_drawer`; clamps at min/max; snap-to-collapse below threshold sets `open:false`.
- A11y: separator has `role="separator"`, `aria-orientation`, `aria-controls`, live `aria-valuenow/min/max`; Left/Right/Enter keyboard resize+toggle; focus ring present.
- DeviceToggle: each preset sets iframe logical width; `aria-pressed` + width badge correct; rotate swaps w/h for mobile/tablet only; default = responsive; choice persists.
- DeviceFrame: Desktop in a narrow drawer applies `scale<1`; Mobile never scaled >1; one scrollbar (wrapper `overflow-hidden`).
- Double-scroll: drawer container has no `overflow-y-auto`; exactly one card-stack scroll region; CodeBrowser internal scroll intact.
- Sacred: iframe still `sandbox="allow-scripts allow-forms allow-popups"` with no `allow-same-origin`; `AkisChat` not remounted when drawer opens/closes (assert stable `key`).

**Live-verify (Brave automation profile, dev.sh, real build):** run a real build → drawer auto-slides in on ready; drag the handle, confirm chat reflows and width persists across refresh; toggle Mobile/Tablet/Desktop and confirm crisp media-query rendering + dark letterbox + scale-down on Desktop; rotate; resize browser to <lg → full-screen overlay + FAB; reopen a past build from History → drawer stays closed (#35); confirm gates still render in chat and Run/TestStats unchanged.

## 12. Risks & open questions

- **Push-split vs pure overlay on desktop (decided: push-split).** Research is unanimous that builders split rather than overlay; the only cost is the chat reflow animation. If the owner prefers the lighter artifacts-style overlay-on-top (chat dimmed beneath), it's a one-line change (drop the root `paddingRight`) — flagging as the single reversible aesthetic decision.
- **`aria-valuenow` semantics:** we report **drawer width %**; if the owner prefers "primary pane (chat) position" per some splitter examples, invert. Pick one and document — mixing confuses screen readers.
- **Mobile Mobile==Responsive equivalence:** on a phone the Mobile preset is a visual no-op. Acceptable (honest width badge), but the owner may prefer hiding the device toggle entirely on `<sm`.
- **Auto-open firing source:** the "preview-ready" trigger keys off `view.preview` flipping for the active run; if a future SSE adds an explicit `preview_ready` event, prefer that over inferring from `url`/`starting` (cleaner, fewer false opens). No backend change required for this design.

---

Key files referenced (all absolute): `/Users/omeryasironal/Projects/akis-platform-mvp/frontend/src/chat/ChatStudio.tsx`, `/Users/omeryasironal/Projects/akis-platform-mvp/frontend/src/components/PreviewPanel.tsx`, `/Users/omeryasironal/Projects/akis-platform-mvp/frontend/src/components/CodeBrowser.tsx`, `/Users/omeryasironal/Projects/akis-platform-mvp/frontend/src/chat/recentBuilds.ts`, `/Users/omeryasironal/Projects/akis-platform-mvp/frontend/src/i18n/catalog.ts`. All grounding file:line claims were verified against current source.


## 13. Design corrections (folded in from the adversarial review)

The 3-lens review returned **gate-safety: CLEAN** and surfaced concrete defects, corrected here. These SUPERSEDE the relevant parts of §2–§10.

**C1 (Feasibility-HIGH, was blocking) — i18n has no interpolation.** `t()` is `(k)=>string`; the catalog stores plain strings with no `t(key, vars)`. So the device width-readout CANNOT be `t('preview.device.width')="{n} px"`. **Fix:** compose the badge in JSX — `{width}` (locale-neutral number) + a suffix key `preview.device.unit="px"/"px"`; the toggle labels are their own keys. No interpolation.

**C2 (Usability-HIGH) — a single scroll wrapper re-creates the double-scroll on the Kod tab.** Wrapping the card-stack + PreviewPanel in one `overflow-y-auto` collapses PreviewPanel's `h-full`/`flex-1` height ancestor → CodeBrowser's inner viewer AND the outer wrapper both scroll. **Fix:** TWO regions in the drawer's vertical flex — (a) the gate-adjacent card stack (Trust/Publish/Proposals/ExternalWrite) in a `shrink-0` top region with its OWN `overflow-y-auto` + a `max-h`; (b) PreviewPanel in a SEPARATE `flex-1 min-h-0` region that does NOT scroll itself, so PreviewPanel keeps a bounded height and owns its internal scroll (iframe band `min-h-[clamp(...)]`, CodeBrowser `min-h-0 flex-1`). Height chain: drawer `flex flex-col h-full` → [cards shrink-0] + [PreviewPanel flex-1 min-h-0].

**C3 (Usability-HIGH) — resize drag dies over the iframe.** **Fix:** while `isDragging`, set `iframe{pointer-events:none}` + a transparent full-drawer capture overlay; keep `setPointerCapture` on a STABLE handle node — the rAF loop writes only the `--preview-w` CSS var (no React commit that remounts the handle). Re-enable on `pointerup`.

**C4 (Feasibility-MED) — width default mischaracterized.** Today's rail is breakpoint-aware `minmax(30rem,46%)/36rem,48%/42rem,50%`. A flat 46% ratio regresses xl/2xl. **Fix:** default ratio is breakpoint-aware (46/48/50% at lg/xl/2xl) AND the clamp keeps the rem floors (min 30rem). A persisted user ratio overrides. This PRESERVES today's widths, just makes them resizable (not a silent narrowing).

**C5 (Feasibility-MED + gate-note) — chat height-collapse when grid → relative+paddingRight.** **Fix:** root stays `flex flex-col lg:h-[calc(100dvh-8.5rem)]`; the chat `<section>` keeps `min-h-0 flex-1` (its scroll ancestor); the drawer is `absolute right-0 inset-y-0` (OUT of the flex flow, can't collapse the chat); the left-shift is `paddingRight:var(--preview-w)` on the root's inner flex container, lg only. Live-verify the chat's internal scroll post-change.

**C6 (gate-LOW) — reopen #35 auto-open.** Drive drawer auto-open off the SAME `autoRan.current === activeSessionId` guard the preview-boot effect uses (a reopen pre-seeds it via `seedRun`), NOT a new independent ref — else a reopened build wrongly auto-opens.

**C7 (gate-LOW) — preserve gate-adjacent invariants.** DeviceFrame WRAPS the existing `<iframe>` verbatim (keep `sandbox="allow-scripts allow-forms allow-popups"` + `allow="clipboard-write"`, NO `allow-same-origin`); moved cards keep their props (`sessionId`, `api`) and the `!sessionGone && isDone` render guards; demo/verified honesty badges stay in PreviewPanel.

All corrections are view-state only → gate-safe; the design is now implementation-ready.

---

## Adversarial review findings

### Gate-safety (akis-gate-keeper)

I have everything needed. The client API confirms the FE holds no gate authority (bare POSTs to gated routes), the sandbox/allowlist are exactly as the design claims, and the design's scope is purely view-state. My adversarial trace is complete.

VERDICT: CLEAN — no gate weakening, no bypass, no chat-spine/SSE-fold/iframe-isolation compromise. The design is frontend-only view state (layout shell, resize, device toggle, drawer open/close). Findings below are confirmations plus minor non-blocking notes; none are gate risks.

GATE-SAFETY CONFIRMATIONS (each traced to code):

1. No gate authority touched. Design §8/§9 leaves `approve` (ChatStudio.tsx:267-271), `confirm` (:272), `runApp` (:286-290), `startBuild` (:213-252), `canRun` (:326) unchanged. The client (`frontend/src/api/client.ts:223/225`) is bare POSTs to gated routes — no FE minting exists today and the design adds none. Resize/toggle/open are pure `useState`/localStorage. CONFIRMED gate-safe.

2. Iframe isolation preserved. Design §8 and the §9 edit note for `PreviewPanel.tsx:163-164` explicitly state "Line 165 sandbox untouched." Current sandbox is `allow-scripts allow-forms allow-popups` (PreviewPanel.tsx:165) with NO `allow-same-origin`. The `DeviceFrame` wrapper changes width/scale only; it does not touch `src`, `sandbox`, or the `embeddable = url.startsWith('/preview/')` allowlist (PreviewPanel.tsx:57). CONFIRMED. Note: `allow="clipboard-write"` is present on the current iframe (line 165) — the design's quoted sandbox string omits it but the design says "untouched," so this is a documentation imprecision, not a regression. The DeviceFrame must wrap the existing iframe element verbatim, not re-author the tag.

3. Chat spine tree-slot preserved. Design §2/§8 keeps `AkisChat key={threadKey}` (ChatStudio.tsx:371-372) and the chat `<section>` at its exact tree slot; the drawer becomes an overlay sibling. The code comment at ChatStudio.tsx:393-395 confirms the remount hazard the design is respecting (a remount discards the inline run marker). The push-split via `paddingRight` on the root does not reparent the section. CONFIRMED — but see Finding A.

4. SSE/fold contract preserved. Design §7/§8 auto-open reads the already-folded `activeView` (the single active-run reporter `onActiveView` ChatStudio.tsx:384) and fires once via a sessionId-keyed ref. It adds NO per-event setState. `PreviewState.starting`/`url` exist on the folded view (live/types.ts:55-78). CONFIRMED no fold-contract break.

5. Reopen (#35) auto-open suppression is the one real correctness hazard, and the design handles it correctly. The design's §7 plan to gate auto-open on "not a reopen" matches the existing mechanism: `seedRun` pre-seeds `autoRan.current = id` (ChatStudio.tsx:152) precisely so the auto-preview effect (:306-314) skips a reopen. CAUTION (LOW): the design proposes a SEPARATE ref keyed by sessionId for drawer auto-open ("guard with a ref keyed by sessionId"). If that new ref is independent of `autoRan`, a reopened build would NOT be suppressed (the new ref was never pre-seeded by `seedRun`). The design text resolves this ("gate the auto-open on the same 'not a reopen' condition") but the §9 ref proposal is ambiguous. Minimal fix: drive drawer auto-open off the SAME `autoRan.current === activeSessionId` check the preview effect uses (a reopen pre-sets it), or have `seedRun` also pre-seed the new drawer ref. This is FE-only correctness, not a gate bypass.

NON-GATE NOTES (LOW, for completeness):

- Finding A (LOW, layout not gate): §2 changes the studio root (ChatStudio.tsx:402) to `relative` and makes the drawer `absolute`. The current rail (`<aside>` at :438-485) renders the gate-adjacent cards (`TrustReportCard`, `PublishButton`, `AgentWriteProposals`, `ExternalWriteCard`, `PreviewPanel`). Moving them into `PreviewDrawer` is fine PROVIDED the cards keep receiving the same props (`sessionId={activeSessionId}`, `api`, owner-scoped reads) — they already POST to gated/owner-scoped routes (`confirmExternalWrite` client.ts:296 sends digest; AgentWriteProposals confirm cards render exact bound bytes per client.ts:128). The design does not alter these props. No risk, but the §6 reorder must not drop the `!sessionGone && isDone` guards (ChatStudio.tsx:455/457/464) — losing those would surface Publish/Trust on a non-done or gone session. The design preserves them ("stay exactly where they are").

- Finding B (LOW, honest-flag preservation): the `view.preview.demo` badge (PreviewPanel.tsx:95) and `isMock` note (:240) live inside `PreviewPanel`, which the design keeps intact. The DeviceFrame wraps only the iframe element, so the demo/verified honesty flags are unaffected. CONFIRMED.

No HIGH/MED findings. The design does not add a route, tool, chat handler, or token path; it cannot move a gate out of the chat (gates render in `AkisChat`/`RunBlock`, untouched per §8); it cannot weaken verify or the digest match (no backend change). An empty gate-finding list is the correct result here.

Files traced: `/Users/omeryasironal/Projects/akis-platform-mvp/frontend/src/chat/ChatStudio.tsx`, `/Users/omeryasironal/Projects/akis-platform-mvp/frontend/src/components/PreviewPanel.tsx`, `/Users/omeryasironal/Projects/akis-platform-mvp/frontend/src/components/CodeBrowser.tsx`, `/Users/omeryasironal/Projects/akis-platform-mvp/frontend/src/chat/recentBuilds.ts`, `/Users/omeryasironal/Projects/akis-platform-mvp/frontend/src/live/types.ts`, `/Users/omeryasironal/Projects/akis-platform-mvp/frontend/src/api/client.ts`.


### Usability & a11y

The grounding is accurate. I have everything I need. Let me give my adversarial review.

---

I reviewed the design doc against the actual source (`ChatStudio.tsx`, `PreviewPanel.tsx`, `CodeBrowser.tsx`, `catalog.ts`). Grounding is accurate. The design is strong on the a11y splitter contract and the sacred constraints, but there are real usability/edge-case gaps. Findings below, severity-tagged, with concrete fixes.

## HIGH

**H1 — The double-scroll fix introduces a NEW double-scroll between the card stack and PreviewPanel.**
The design's "one scroll wrapper" wraps *all* drawer content — the stacked cards (`TrustReportCard`, `PublishButton`, `AgentWriteProposals`, `ExternalWriteCard`) PLUS `PreviewPanel` — in a single `min-h-0 flex-1 overflow-y-auto`. But `PreviewPanel` (line 64) is `flex h-full flex-col` and on the Code tab `CodeBrowser` has its own internal `overflow-auto` viewer (line 86) plus an `overflow-y-auto` file list (line 55). If `PreviewPanel` lives *inside* the card-stack scroller, its `h-full`/`flex-1` collapse to content height (the parent is now auto-height, not bounded), so the iframe band's `min-h-[clamp(16rem,55vh,42rem)]` (line 136) and CodeBrowser's `min-h-0 flex-1` both lose their height ancestor — you get the outer card scroller scrolling AND CodeBrowser's inner viewer scrolling = two stacked scrollbars again, exactly the bug being killed. Today this works only because the `<aside>` is the single scroll context and PreviewPanel is a direct flex child of a height-bounded grid cell.
**Fix:** Two scroll *regions*, not one. The card stack gets its own `overflow-y-auto` region; `PreviewPanel` sits in a SEPARATE `flex-1 min-h-0` (non-scrolling) region below it so it keeps a bounded height and owns its internal scroll. Or make the drawer a vertical flex with the cards in a `shrink-0`/`max-h` collapsible top section and PreviewPanel filling the rest. The doc's single-wrapper claim is wrong for the Code tab; spell out the height chain explicitly.

**H2 — `setPointerCapture` on the separator + an iframe in the drawer = drag deadlock when the pointer crosses the iframe.**
The resize handle is on the drawer's *left edge* and drags *left* to widen — i.e. the pointer moves toward the chat, away from the iframe, which is mostly fine. But on *narrowing* (dragging right, into the drawer) the pointer travels over the same-origin-blocked iframe. Even with `setPointerCapture`, fast drags that release over the iframe are usually OK, but during the drag the iframe will not eat events (capture holds) — however the doc never adds `pointer-events:none` to the iframe during drag, and any mid-drag re-render that drops capture (e.g. the rAF write triggering a React commit that recreates the handle node) silently strands the drag. This is the classic "drag dies over the iframe" bug.
**Fix:** Set `iframe { pointer-events: none }` (and ideally a transparent full-drawer overlay) for the duration of `isDragging`. The doc mentions disabling the width transition during drag but not neutralizing the iframe — add it explicitly to the contract.

**H3 — Restored-off-screen / stale-ratio persistence has no validation path described for the `open:true` + zero-room case.**
The doc persists `{ratio, open}` and rehydrates `open` from storage. Edge case: a user resizes the drawer near max on a wide monitor, persists `open:true`, then reopens on a narrow laptop where `maxPx = min(60%, 100% − 28rem)` would push the chat below the 28rem floor. The clamp handles `ratio`, but the doc never says the *clamp runs on rehydrate before paint* for the persisted ratio — it only says "ratio not pixels so it survives viewport changes," which is necessary but not sufficient (a 60% ratio on a 1024px viewport leaves chat = 410px, fine; but a persisted ratio saved when `28rem` floor wasn't binding can still violate it on a smaller screen). Also: `open:true` rehydrating on a `<lg` viewport must NOT auto-show the full-screen overlay on load (jarring — user lands on a build and the preview slams over the whole screen before they've oriented).
**Fix:** (a) Re-clamp the rehydrated ratio against the *current* viewport on mount, before paint. (b) On `<lg`, ignore persisted `open:true` for the auto-show-on-load case — require an explicit FAB tap, OR only honor it if it was the active surface. State this as an explicit rehydrate rule.

## MEDIUM

**M1 — `aria-valuenow` as "drawer width %" is the wrong choice for a separator and will mislead SR users.** The W3C Window Splitter pattern expects `aria-valuenow` to describe the *primary pane's* size (the resizable region the separator controls via `aria-controls`). The doc picks "drawer width %" and flags the ambiguity as an open question — but it's not really a coin-flip: `aria-controls` points at the drawer, so reporting the drawer's own size is defensible, yet "more = more chat" is what the keyboard mapping implies (Left/End *widen the drawer*, narrowing chat). The doc's own keyboard mapping ("Left/End widen") combined with "valuenow = drawer %" means pressing Left *increases* valuenow while *shrinking* the chat — internally consistent but the `aria-label` "Resize preview panel" plus an increasing number is fine. The real risk: `aria-valuetext` is missing. A bare percent ("46") is opaque.
**Fix:** Add `aria-valuetext` like "Preview 46% of width" / "Önizleme genişliğin %46'sı". Keep valuenow = drawer %, document it once, and make `aria-controls`→drawer consistent. Resolve the open question rather than shipping it ambiguous.

**M2 — Mobile overlay is missing the core overlay a11y contract the doc claims to honor.** Section 5 says full-screen `fixed inset-0 z-50` with a backdrop scrim and close X, but never specifies: Escape-to-close, focus trap inside the overlay, focus-return to the FAB on close, `role="dialog"` + `aria-modal="true"` + `aria-label`, and body scroll-lock. The task explicitly asks about "mobile overlay escape/scroll-lock" — the doc is silent on all of it. Without scroll-lock, the chat behind scrolls under the overlay (iOS rubber-band). Without a focus trap, Tab leaks to the chat behind.
**Fix:** Specify `role="dialog" aria-modal="true"`, Escape handler, focus trap, focus-return, and `overflow:hidden` on `<body>` (or `overscroll-behavior: contain`) while the overlay is open. This is load-bearing for the mobile story and currently absent.

**M3 — Auto-open trigger keys off `view.preview.starting` flipping true, which fires BEFORE there's anything to show.** Section 7 opens the drawer when "`view.preview.url` becomes embeddable OR `view.preview.starting` flips true." But `starting:true` is the *booting spinner* state (PreviewPanel line 195: "Booting the app…") — opening the drawer at `starting` means the artifact-on-screen convention degrades to "slide in a spinner," which is exactly the empty-shell jank the design says it's avoiding (principle: "nothing on screen until there is something to show"). Worse, `starting` can flip true on the auto-run effect (line 309) the instant a build hits `done`, so the "auto-open the moment there's an artifact" becomes "auto-open the moment we start trying to boot."
**Fix:** Gate auto-open on `embeddable` URL ready (`url.startsWith('/preview/')` AND iframe `loaded`) OR on `isDone` with content, NOT on `starting`. The doc's own open-question #4 (prefer a future explicit `preview_ready` event) is the right instinct — but the *current* design should open on `done`/url-ready, not on `starting`.

**M4 — Removing the collapsed 4rem strip drops the verified-dot at-a-glance signal with no stated replacement on desktop.** Today the collapsed strip (lines 478-481) shows a verified/unverified dot even when collapsed — a real trust affordance (AKIS's whole thesis is verifiability legibility). The doc replaces the strip with "a slim tab on the right edge" but only specifies a verified dot on the *mobile FAB*, not the desktop edge tab. So a desktop user who closes the drawer loses the persistent pass/fail glance.
**Fix:** Carry the verified dot onto the desktop edge-tab trigger too (it's cheap and on-brand). Spell it out.

**M5 — Device-toggle "width readout badge" + segmented control + rotate + existing demo/verified/Run cluster will overflow the toolbar in the narrow drawer, especially in Turkish.** PreviewPanel's toolbar (lines 90-112) already holds demo pill + verified pill + Run, and on the Code/Trust tabs a tablist sits on the left (line 69). Adding a 3-button segmented control + a "{n} px" badge + a rotate button into the same row, inside a drawer that can be dragged down to `minPx = 30rem` (480px) minus padding, will wrap or clip — and TR labels ("Duyarlı", "Masaüstü", "yeniden boyutlandır") are longer. The doc asserts "never icon-only" but doesn't budget the horizontal space.
**Fix:** Either make the device control icon-only with the px-badge as the live readout (icons + `aria-label` satisfy a11y; the badge gives the visible text the doc wants), or move the device toggle to its own row, or collapse it into a popover at narrow widths. Add a width-budget note. Also: when on the Code or Trust tab, the device toggle is meaningless — hide it unless `activeTab === 'preview'`.

**M6 — Touch targets on the desktop resize handle and the device buttons are below 44px.** The handle is a "12px-wide hit-area." 12px is fine for a mouse but fails the 24px minimum (WCAG 2.2 SC 2.5.8) and the 44px comfortable target. The collapse chevron today is `px-2 py-1 text-xs` (~24px tall) — borderline. The new device segmented buttons described as "icon + label" need a min 44×44 (or 24×24 minimum) tap area; the doc doesn't set a min-height.
**Fix:** Handle hit-area ≥ 24px wide (visual hairline can stay 1px). Device buttons `min-h-[44px]` on touch, ≥24px always. State the minimums.

**M7 — Keyboard "Enter toggles collapse" on a `role="separator"` is non-standard and collides with expectations.** The W3C splitter pattern uses Enter to toggle collapse only as an *optional* behavior, and the doc's "collapse → restore previous width" is good — but a separator with `tabindex=0` that also closes the whole drawer on Enter is surprising; users expect Enter on a focused separator to do nothing or toggle. More importantly, once collapsed (drawer closed, `previewOpen=false`), the separator is gone (it lives on the drawer which is `translateX(100%)` off-screen) — so Enter-to-restore is impossible from the same control. Focus is lost.
**Fix:** On collapse-via-Enter, move focus to the persistent edge-tab/FAB trigger (the reopen affordance) so the keyboard user isn't stranded. Document the focus handoff both ways (open via trigger → focus the separator).

## LOW

**L1 — `translateX(100%)` closed state still occupies layout/compositor and can cause closed→open jank on first open.** With `transform: translateX(100%)` the drawer is rendered (just off-screen) including the iframe, which means the same-origin-blocked app *boots and runs while invisible* if `PreviewPanel` is mounted. The doc says auto-run boots the process regardless, so this may be intended — but mounting a live iframe permanently off-screen wastes a process and risks the "closed→open transition jank" the task asks about (first paint of a heavy iframe on slide-in). **Fix:** consider `visibility:hidden` + `content-visibility:auto` when closed, or defer iframe mount until first open; at minimum note that the iframe stays mounted-but-hidden and why that's acceptable.

**L2 — Snap-to-collapse at `minPx/2` with no hysteresis = flicker near the threshold.** Dragging around ~15rem will repeatedly cross the snap line; without a deadzone the drawer will snap shut and the user may immediately drag back. **Fix:** snap only on `pointerup` below threshold (not mid-drag), or add hysteresis (snap shut at 15rem, only re-open by an explicit action).

**L3 — `paddingRight: var(--preview-w)` on the studio root will fight the existing `lg:h-[calc(100dvh-8.5rem)]` height-bounded layout and the chat's `mx-auto max-w-*` centering in a subtle way.** The chat clamp (line 430) centers within the *padded* box; as the drawer widens, the centered chat shifts left, which is the intended "reflow," but the `max-w-6xl` clamp means past a point the chat stops shrinking and just gains left margin — so "chat reflows into remaining space" is only true until the clamp binds, then it's "chat pins to a max width with growing right gap." Cosmetically fine, but the doc oversells "lockstep" reflow. **Fix:** note that beyond the max-w clamp the chat stops narrowing; consider dropping/raising the clamp when the drawer is open.

**L4 — `preview.device.width: '{n} px'` uses a `{n}` placeholder but the existing i18n catalog has no interpolation convention shown.** Every other key in the catalog is a static string; the design introduces a templated value without confirming the `useI18n` `t()` supports interpolation. If it doesn't, "{n} px" renders literally. **Fix:** verify `t()` interpolation support (or build the badge as `` `${n} px` `` in JSX and drop the templated key), and note RTL: in Arabic/Hebrew "390 px" should keep the number+unit LTR-isolated (`dir="ltr"` or `&#8234;`), which px-badges commonly get wrong.

**L5 — RTL: the entire design assumes the drawer is on the *right* and the handle on its *left edge*; there is no RTL story.** AKIS ships EN + TR (both LTR), so this is low priority today, but the doc claims "RTL/i18n length" is considered and it isn't — a future RTL locale wants the drawer mirrored to the left with the handle on the right, and "Left widens" inverts. **Fix:** at minimum acknowledge RTL is out of scope (TR is LTR) so the claim is honest, or key the side off `dir`.

## "Simpler or just different?" verdict

**Genuinely simpler in two places, more complex in two, net roughly even — leaning *better* IF H1/H2/M2 are fixed.**
- *Simpler:* killing the grid-template-columns transition + the collapsed-4rem-strip special case, and the single `--preview-w` source of truth, are real reductions. The closed-by-default + auto-open is a cleaner mental model than always-open.
- *Not simpler / new surface area:* a custom `useResizable` (~90 LOC), a `DeviceFrame` with `ResizeObserver` + scale-to-fit, a focus-trapped mobile overlay, and a new persistence schema add meaningfully more code and more failure modes (drag/iframe interaction, scroll-region height chains, rehydrate clamping) than today's pure-CSS grid. The device toggle in particular is *new capability*, not a simplification — judge it on its own merit, not as "cleaner."
- The honest framing: this is a **capability upgrade (resize + device emulation) wearing a "cleaner" label**. The genuinely-cleaner part (drawer model) is ~30% of the work; the other 70% (resize a11y, device frame, scale-to-fit) is new feature surface. Worth doing, but the doc should not sell the whole thing as "simpler than today."

## Net
Not clean — H1 (height-chain double-scroll on the Code tab) and M2 (missing mobile overlay a11y contract) are the two that would ship broken. H2/M3/M5 are real. Fix H1, H2, M2, M3 before build; M1/M4/M5/M6/M7 are cheap and should land in the same pass. The a11y *splitter* contract is otherwise the strongest part of the doc.

Files reviewed (all absolute): `/Users/omeryasironal/Projects/akis-platform-mvp/frontend/src/chat/ChatStudio.tsx`, `/Users/omeryasironal/Projects/akis-platform-mvp/frontend/src/components/PreviewPanel.tsx`, `/Users/omeryasironal/Projects/akis-platform-mvp/frontend/src/components/CodeBrowser.tsx`, `/Users/omeryasironal/Projects/akis-platform-mvp/frontend/src/i18n/catalog.ts`.


### Feasibility & correctness (akis-reviewer)

I have all the evidence I need. Let me compile the feasibility findings.

FEASIBILITY REVIEW — Preview-drawer design vs. actual code

VERDICT: Wiring is mostly accurate and feasible, but there is one BLOCKING i18n defect and several layout/integration claims that are wrong or unverified. The "double-scroll fix" and "device-width" mechanics are sound; the grid→overlay reflow mechanism is sound but the design under-specifies a real height-collapse risk.

---

HIGH — `preview.device.width` `{n} px` interpolation is impossible with the current `t()` — design is infeasible as written
- Evidence: `/Users/omeryasironal/Projects/akis-platform-mvp/frontend/src/i18n/I18nContext.tsx:4` and `:38` — `t: (k: StringKey) => string`; the catalog stores plain strings (`/Users/omeryasironal/Projects/akis-platform-mvp/frontend/src/i18n/catalog.ts`) with NO interpolation helper (grep for `replace(`/`interpolat` in catalog returns nothing). The design (§10) defines `preview.device.width` = `{n} px` / `{n} px` and §4 promises a live "390 px" readout badge.
- Why: `t('preview.device.width')` returns the literal string `"{n} px"`. There is no `t(key, {n})` overload anywhere in the codebase. The width-readout feature cannot render a number through `t()`.
- Fix: Drop the `{n} px` key entirely and render the badge as `{width}px` with a separate localized unit/label key (e.g. `preview.device.width` = `px` / `px`, used as a suffix), or compose `<span>{width}</span><span>{t('preview.device.width')}</span>`. The numeric value is locale-neutral; only the label needs `t()`.

---

MED — "matches today's grid 46%" is a mischaracterization; the existing grid is `minmax(30rem, 46%)`, not a 46% fraction of studio width
- Evidence: `ChatStudio.tsx:427` — `lg:grid-cols-[minmax(0,1fr)_minmax(30rem,46%)] xl:…48% 2xl:…50%`. Design §2 sets a single `previewWidth` ratio default 46% and claims it "matches today's `minmax(30rem,46%)`".
- Why: Today the rail is responsive across three breakpoints (46/48/50%) AND floored at 30rem/36rem/42rem. A single 46% ratio is NOT equivalent: at xl/2xl it is narrower than today, and below ~65rem viewport the 30rem floor dominates (46% < 30rem), so a flat 46% ratio is visibly narrower than current behavior on common laptop widths. The clamp `[minPx=30rem, maxPx=min(60%, 100%−28rem)]` in §2 partially covers the floor but the default ratio still regresses xl/2xl width.
- Fix: Either keep breakpoint-aware defaults, or state honestly that this intentionally normalizes the rail to a flat 46% (a behavior change), not a match.

---

MED — Dropping the grid for `paddingRight` push-split risks chat height collapse; design does not address the flex/min-h-0 chain
- Evidence: Root is `flex min-h-0 flex-1` grid today (`:427`); the chat `<section>` relies on being a grid cell with `min-h-0` (`:428`) for its internal scroll to work; `:402` root is `flex flex-col lg:h-[calc(100dvh-8.5rem)]`. Design §2/§9 makes the chat `<section>` a normal block child of a `relative` root with inline `paddingRight`, and makes the drawer `absolute right-0 top-0 h-full`.
- Why: An `absolute` drawer is removed from flow, so the parent's height is now driven ONLY by the chat section. The current `min-h-0 flex-1` height plumbing (the whole point of the "height-bounded so chat scrolls inside" design, see `:391-395`) depends on the grid/flex child relationship. Converting the chat section to a padding-shifted block without re-establishing `flex-1 min-h-0 h-full` on it can collapse the chat to content height or break its internal scroll. The design asserts "its existing `mx-auto max-w-*` clamp does the centering" but `mx-auto` is on the INNER div (`:430`), not the section; the section itself has no width clamp — it is full-width by being a flex/grid child. As a plain block it is full-width too, so centering still works, BUT the height contract is unaddressed.
- Fix: Specify that the chat `<section>` must keep `flex-1 min-h-0 h-full` (or the root stays `flex`, chat is `flex-1`, drawer is the absolute sibling) so the viewport-height clamp at `:402` still bounds the chat. Add this to the "files:lines to change" for `:428`.

---

MED — Auto-open trigger "view.preview.starting flips true … OR view.preview.url becomes embeddable" can fire on a reopened build despite the #35 guard, because the guard is keyed on `autoRan`, not on the new open-ref
- Evidence: `ChatStudio.tsx:152` `autoRan.current = id` in `seedRun` suppresses auto-PREVIEW-boot on reopen; the auto-preview effect at `:306-314` boots the process. Design §7 says gate auto-open on "the same not-a-reopen condition (only fire when `autoRan` was set by completion, not by `seedRun`)" — but `autoRan` is a single ref with no provenance flag distinguishing seedRun-set vs completion-set.
- Why: After a reopen, `seedRun` sets `autoRan.current = id`. The design wants auto-open to fire only when autoRan was set "by completion." But there is no stored discriminator — both paths write the same ref. A reopened build that the user then manually Runs (or whose backend is still `done`) will flip `view.preview.starting`/`url`, and the proposed once-per-run open-ref (keyed by sessionId) has no way to know this id was a reopen. The design's own "honor #35" requires a NEW provenance signal it does not define.
- Fix: Add an explicit `reopenedIds` ref (Set) set in `seedRun`, and gate auto-open on `!reopenedIds.has(activeSessionId)`. Or set the auto-open once-ref to the session id inside `seedRun` (pre-seed it the same way `autoRan` is pre-seeded at `:152`) so a reopened build is treated as already-opened. The design names the requirement but omits the mechanism — it must be specified or it will regress #35.

---

LOW — `PreviewPanel` "root → add min-h-0" at line 64 is redundant/ineffective without a height ancestor; the real height already comes from `lg:h-[calc(...)]` two levels up
- Evidence: `PreviewPanel.tsx:64` root is `flex h-full flex-col gap-3`; it already has `h-full`. Inside the drawer (design §6) the design also adds `min-h-0` here. `min-h-0` matters on a FLEX CHILD that must shrink; the PreviewPanel root would be a child of the drawer's scroll body. Design §6 says the card-stack wrapper is `min-h-0 flex-1 overflow-y-auto` and PreviewPanel sits inside that scroll wrapper alongside the cards.
- Why: If PreviewPanel is inside an `overflow-y-auto` card-stack wrapper (as §6 states: "the scroll body containing the stacked cards … followed by PreviewPanel"), then PreviewPanel's internal `flex-1` band (`:136` `flex-1` + `lg:min-h-[28rem]`) sits in a SCROLLING container with no definite height — `flex-1` is inert there, and the iframe band falls back to its `min-h-[clamp(16rem,55vh,42rem)]` floor. The "one scrollbar for the card stack" goal and "PreviewPanel owns its scroll / iframe fills" goal are in tension: you cannot both put PreviewPanel inside the card-stack scroller AND have its iframe `flex-1`-fill the drawer height. Adding `min-h-0` to `:64` does not resolve this.
- Fix: Decide the layout: either PreviewPanel is a `flex-1 min-h-0` sibling OUTSIDE the card scroller (so its iframe fills remaining drawer height — matches today's behavior), with the cards in their own scroller above; or accept that inside a scroller the iframe uses its clamp floor (and `flex-1`/`min-h-0` on `:64` is decorative). §6 currently asserts both.

---

Verified-correct claims (no finding):
- Sandbox at `PreviewPanel.tsx:165` = `sandbox="allow-scripts allow-forms allow-popups"` (no `allow-same-origin`); design correctly leaves it untouched. Embeddable allowlist `url.startsWith('/preview/')` is at `:57` (design said `:57` ✓).
- `max-w-[1100px]` letterbox is at `PreviewPanel.tsx:164` (design said 163-164 ✓); replacing it with a `DeviceFrame` wrapper is feasible — the iframe `src`/`sandbox` are independent of the wrapper width, so device-width-driving the wrapper works with the existing sandbox + `mx-auto` letterbox.
- `previewOpen` default at `ChatStudio.tsx:73` ✓; grid at `:427` ✓; aside at `:438-485` with `overflow-y-auto` at `:439` ✓ (the load-bearing double-scroll edit target is real); collapsed 4rem strip at `:468-483` ✓; auto-preview effect at `:306-314` ✓; mobile tablist at `:406-423` ✓; `autoRan` reopen pre-seed at `:152` ✓; `AkisChat key={threadKey}` at `:371-372` ✓ (remount-on-key concern is real and correctly flagged as sacred).
- CodeBrowser internal scroll regions at `:53/:55/:86` ✓ — they own their own scroll and need no change; the double-scroll fix is sound for the Code tab.
- All "reused" i18n keys exist in BOTH catalogs: `preview.collapse/expand/collapsed/run/verified/unverified` (EN 187-205, TR 955-973). New keys (`preview.open/close/resize`, `preview.device.*`) are absent — consistent with "new" (must be added to BOTH blocks: EN ~185-225, TR ~953-991, confirmed boundaries).
- Strict flags confirmed: `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true` (`../tsconfig.base.json:6-8`). The optional-prop spread pattern (`{...(makeClient ? {makeClient} : {})}`) is already the house style (`:375/:379/:380`) and applies to the new optional drawer props.
- `view.preview` shape (`src/live/types.ts:56-126`, `viewModel.ts:121-126`) carries `starting`/`ready`/`url` — the auto-open trigger keying off these is data-feasible (the gating logic is the issue, see MED above).
- Bundle-impact claim ("custom `useResizable`, zero deps") is honest: no `react-resizable-panels` or splitter lib is in the tree (no such import anywhere in `src/`); the Pointer-capture + rAF + CSS-var approach needs no new dependency.

No SSR/HMR-specific pitfall found beyond the existing `typeof window` guards (the codebase already guards `window`/`localStorage`/`document`, e.g. `I18nContext.tsx:13-14`, `ChatStudio.tsx:92/121/301`); the new persistence hooks should mirror that try/catch pattern (recentBuilds.ts:29-42 is a valid template).


---

## Research appendix

### Lens 1 — reference apps

I now have comprehensive, well-cited coverage of all eight tools across split-vs-overlay, default state, resize, collapse, new-tab, and reflow. Here is the findings brief.

---

# Research Lens 1 — Reference-app preview/artifact panes

## Per-product findings

**Claude Artifacts** — Side panel (split), to the RIGHT of chat. Closed-by-default; opens automatically the moment Claude produces an artifact (chat reflows to the left half). Has a Preview/Code tab toggle at the top, version-history scrubber, and bottom-bar actions: Download, Copy, **Publish** (shareable link, no account needed to view; remixable). No drag-to-resize on the divider; collapses back to full-width chat via an X.

**Vercel v0** — Split layout, chat left / work area right. Right pane has a **Preview/Code tab toggle**, responsive-viewport sizes, fullscreen, and open-in-new. Iteration via chat follow-ups (global) or inline element selection (targeted). Always-on once a generation exists; a recent "VS view" interface change drew user complaints when it altered/hid the preview — a caution about changing a familiar pane layout.

**bolt.new** — Built-in editor with a live **split** preview pane. Top-center `<>` icon toggles Code ↔ Preview; **Preview / Code / Database** are unified tabs. Responsive Mode for mobile/tablet/desktop. Open-in-new-tab supported (with a known failure mode where new-tab opening intermittently breaks).

**Lovable** — Classic split: **chat left, persistent live-preview right**. Preview is always-on; supports a Visual Edits mode (click an element in the preview to edit text/color/layout, sliders/pickers) — preview doubles as a direct-manipulation surface, not just a viewport.

**Replit Agent (Preview/Webview)** — Dockable pane, auto-placed top-right; **auto-opens on run** (toggleable in settings). Address bar, back button, **open-in-new-tab**, responsive device-size presets, embedded DevTools (Eruda). Replit "Splits" let users freely re-tile any pane. Not a modal overlay — a managed dock.

**StackBlitz** — Editor center, sidebar left, **preview pane right** as an embedded mini-browser (iframe + address bar). **"Open in New Window" closes the in-IDE preview and moves it to a separate tab** (one-or-the-other, not both). Terminal as another docked panel.

**ChatGPT Codex (new UI)** — **Task sidebar** follows the agent (plan, sources, artifacts, summary); a **Git diff pane** with inline comments + chunk-level stage/revert. Sidebar previews non-code artifacts (PDF/sheets/docs/decks). Can **pop a thread into a separate window** with optional "stay-on-top." In-app browser annotates page elements.

**Cursor 2.0 / 3** — In-app browser is a **resizable, draggable split pane**; recommended **three-way split** (code left, preview right, terminal bottom), re-stackable (preview over DevTools). Toggleable via shortcut, not permanently fixed. Cursor 3 went "agent-first": all agents in a unified sidebar, classic split layout retained as an option.

## Strongest conventions worth adopting
1. **Split pane, not overlay drawer.** Every serious builder (v0, bolt, Lovable, StackBlitz, Cursor, Replit) uses a side-by-side split — chat/code left, preview right — so both stay visible. Overlay drawers are absent here.
2. **Open-on-first-artifact, collapsible back to full-width.** Claude's "closed until there's something to show, then auto-open" is the cleanest default; pair it with an explicit collapse/expand affordance.
3. **Preview/Code (and Database/Diff) tab toggle inside the pane** — universal (v0, bolt, Claude). One pane, multiple lenses.
4. **Embedded mini-browser chrome**: address bar + back + reload + **open-in-new-tab** (Replit, StackBlitz, bolt).
5. **Responsive viewport presets** (mobile/tablet/desktop) on the preview toolbar — Replit, bolt, v0.
6. **Resizable divider with drag handle** (Cursor, StackBlitz behavior) — and persist the width across sessions.
7. **Pop-out to a separate window** for multi-monitor work (Codex "pop out," StackBlitz "Open in New Window") + **Publish/share link** for the artifact (Claude).

## Anti-patterns to avoid
- **Mutually-exclusive new-tab** (StackBlitz closes the in-app preview when you open a new window) — prefer opening a new tab *in addition to* the docked preview.
- **Changing/hiding a familiar pane layout** without a migration path (v0's "VS view" backlash; Cursor users objected to a side panel that auto-closes/reopens on focus change → constant re-layout).
- **Fragile open-in-new-tab** (bolt's reported failures) — make the popped-out URL stable and directly reachable.
- **No collapse affordance** — never trap the user in a split they can't dismiss back to full-width chat.

## Sources
- [Claude Artifacts guide (Albato)](https://albato.com/blog/publications/how-to-use-claude-artifacts-guide)
- [v0 by Vercel guide (Bitcot)](https://www.bitcot.com/v0-vercel-ai-website-app-builder-guide/) · [v0 preview-pane interface-update complaints (Vercel Community)](https://community.vercel.com/t/v0-preview-pane-not-displaying-app-after-interface-update/32310)
- [bolt.new Code View (support.bolt.new)](https://support.bolt.new/building/using-bolt/code-view) · [Bolt V2 power features](https://bolt.new/blog/inside-bolt-v2-hidden-power-features)
- [Lovable Visual Edits](https://lovable.dev/blog/introducing-visual-edits) · [Lovable design docs](https://docs.lovable.dev/features/design)
- [Replit Preview docs](https://docs.replit.com/replit-workspace/workspace-features/preview) · [Replit Splits](https://blog.replit.com/splits)
- [StackBlitz IDE layout docs](https://developer.stackblitz.com/guides/user-guide/ide-whats-on-your-screen)
- [OpenAI Codex app features](https://developers.openai.com/codex/app/features) · [Codex changelog](https://developers.openai.com/codex/changelog)
- [Cursor 2.0 in-app browser (Skywork)](https://skywork.ai/blog/vibecoding/cursor-2-0-in-app-browser/) · [Cursor 3 agent-first layout (The Decoder)](https://the-decoder.com/new-cursor-3-ditches-the-classic-ide-layout-for-an-agent-first-interface-built-around-parallel-ai-fleets/) · [Cursor split-panel re-layout bug](https://forum.cursor.com/t/multi-window-split-agent-right-side-panel-closes-reopens-on-window-focus-change-causing-constant-re-layout/162434)


### Lens 2 — device toggle

I now have comprehensive coverage across all six tools plus the implementation mechanics. Here is the findings brief.

---

# Research Lens 2 — Device/Viewport Toggle in a Preview Pane

## How the major tools do it

**v0 (Vercel).** A small device-icon toggle sits at the top of the preview pane; clicking it flips between desktop and a phone-width view (and back). v0 leans on the fact that its output is responsive by default, so the toggle is deliberately minimal — a binary-ish switch, not a device gallery. Vercel has shipped, removed, and re-added screen-size previewing here, so treat it as a "keep it simple" signal.

**Lovable.** A device switcher at the top of the canvas with explicit presets: Desktop, Tablet, Mobile Landscape, Mobile Portrait. Caveat repeatedly raised by users: the default is desktop-width, so people ship without ever checking phone — argument for defaulting the toggle prominently or remembering last choice.

**bolt.new / StackBlitz.** The WebContainer preview is a live iframe in an IDE pane; device-size preview exists but is lightweight — resizable preview pane rather than a rich device-frame gallery.

**Replit.** Preview pane offers device screen-size presets for responsive testing, plus iOS Simulator / Android Emulator for true mobile apps. Presets-dropdown model.

**Chrome DevTools Device Mode (the canonical reference).** Two distinct mechanisms that matter for your design:
- **Viewport dimensions** = the simulated device size (changes what CSS sees, e.g. `width:768`). Width presets: 320 (Mobile S), 375 (Mobile M), 425 (Mobile L), 768 (Tablet), 1024 (Laptop), 1440 (Laptop L), 2560 (4K). Plus a draggable "Responsive" handle.
- **Zoom / fit-scale** = magnification only, does NOT change what CSS sees. DevTools auto-fits the large viewport into the small panel via a fit-to-window scale, while DPR is emulated separately. **Rotate** button swaps portrait/landscape.

**Figma.** Frame-preset list (phones/tablets/desktops). Recommended canonical design widths: phone **375**, tablet **768**, desktop one wide frame. Real device points: iPhone 16 Pro Max 440, iPhone 16 Pro ~402/393, iPad 11" 834. In inline preview only mobile/tablet device frames show; full device frames appear in presentation mode.

## The crucial implementation choice: iframe-width vs transform-scale

There are two ways to make an embedded app render "as a phone":

1. **Set the iframe width to the real device width (e.g. `width:390`).** The app's CSS media queries fire correctly at that breakpoint. Pixel-perfect and crisp because there's no scaling. Downside: a 1280px desktop preview may overflow a narrow pane (needs horizontal scroll or a wrapper).

2. **Render at full breakpoint width, then `transform: scale(factor)` to fit.** `scaleFactor = container.clientWidth / breakpoint`, with `transform-origin: top left`, and counter-scale the iframe height (`container.clientHeight / scaleFactor`); use a `ResizeObserver` to recompute on resize. This is how desktop-in-a-small-pane previews fit. Downside: transform scaling can blur text/raster and shift click targets if origin/rounding is off.

**Best practice = combine them.** Set the iframe's *width* to the true device width so media queries are authentic, and apply transform-scale ONLY when the chosen width exceeds the available pane (i.e., scale-to-fit-down, never scale up a mobile view). Keep DPR=1 on the wrapper and let the iframe own its own DPR so text renders from the app's own rasterizer (crisp). Always one scrollbar — let the iframe scroll, hide overflow on the wrapper.

## Accessibility & crispness notes
- Toggle buttons need `aria-pressed`/`aria-label` ("Mobile preview, 390px") and visible focus rings; expose current width as text so it's not icon-only.
- Avoid `transform: scale` on the mobile view itself — it muddies text and breaks pointer hit-testing; only scale to shrink an oversized (desktop) frame into the pane.
- Add a width readout badge (e.g. "390 px") so users know exactly what breakpoint they're testing.

## Recommended toggle model for AKIS
- **Three presets + one fluid:** Mobile **390** (modern iPhone; 375 still common as fallback), Tablet **768**, Desktop **1280** (or fluid "fit"). Add a "Responsive/fluid" mode that just lets the pane width drive the iframe.
- **Mechanism:** drive the **iframe width attribute** to the preset (authentic media queries, crisp). Apply `transform: scale(min(1, paneWidth/presetWidth))` with `transform-origin: top left` + `ResizeObserver` ONLY to shrink Desktop into a narrow pane — never to scale Mobile/Tablet up.
- **Extras:** a rotate button (swap w/h for mobile/tablet), a visible "390 px" width badge, remember last-selected device, optional thin device frame (cosmetic only — keep it off by default for crispness).

## Sources
- [Chrome DevTools — Device Mode](https://developer.chrome.com/docs/devtools/device-mode)
- [v0 community — previewing screen sizes / mobile view](https://community.vercel.com/t/gone-previewing-screen-sizes-in-v0/10091)
- [Vercel Academy — Customize with Prompts (v0 preview)](https://vercel.com/academy/v0-foundations/customize-with-prompts)
- [Lovable docs — Getting started](https://docs.lovable.dev/introduction/getting-started) · [RapidDev — Lovable responsive across devices](https://rapidevelopers.com/lovable-issues/making-lovable-projects-fully-responsive-across-devices)
- [bolt.new (StackBlitz) GitHub](https://github.com/stackblitz/bolt.new)
- [Replit docs — Preview pane](https://docs.replit.com/replit-workspace/workspace-features/preview)
- [Figma — Set prototype device settings](https://help.figma.com/hc/en-us/articles/21158597546391-Set-prototype-device-and-background-settings) · [Figma frame dimensions for Apple devices (gist)](https://gist.github.com/eonist/18be805f94a42b6c5621e07ccbdf1724)
- [Max Schmitt — Building a responsive website tester with iframes (scale impl)](https://maxschmitt.me/posts/iframe-react-responsive-website-tester)
- [Mudos Digital — CSS transform-origin & scale for preview containers](https://mudosdigital.com/css-transform-origin-and-scale-with-responsive-preview-containers/)
- [Polypane — Device presets](https://polypane.app/docs/device-presets/)


### Lens 3 — resizable engineering

I have enough authoritative material. Let me write the findings brief.

---

# Research Lens 3 — Resizable Split-Panel Engineering (React/Tailwind, dependency-light)

## Layout mechanism: CSS Grid wins for a 2-pane split
Three techniques dominate. **`flex-basis`/`flex-grow`** is what most libraries (react-resizable-panels, allotment) use, but it requires `min-width:0`/`min-height:0` on both container and children or flex items refuse to shrink below intrinsic content size — a classic footgun. **`transform`** is cheapest to animate but doesn't actually reflow sibling content, so it's wrong for a true split. **CSS Grid** (`grid-template-columns: <left> 6px 1fr`) is the cleanest for exactly two panes: you mutate one value and the gutter + second pane follow deterministically. Drive that single value through a **CSS custom property** (`--pane-w`) rather than React state during the drag — style recalc on one variable is cheap, and you avoid a re-render per pointermove.

## Pointer handling: Pointer Events + capture + rAF
Use **Pointer Events**, not mouse/touch pairs — one code path covers mouse, touch, and pen. On `pointerdown`, call **`setPointerCapture(e.pointerId)`** on the handle: this routes all subsequent moves to the handle even when the cursor outpaces it or leaves the window, eliminating global `document` listeners and the "drag breaks when you move fast" bug. Batch the DOM write inside **`requestAnimationFrame`** (coalesce: store the latest clientX, write once per frame) to avoid layout thrash. Set `touch-action:none` on the handle so touch-drag doesn't scroll, and disable any width `transition` during the drag (re-enable for snap/collapse) so reading-then-writing doesn't force synchronous reflow.

## Constraints, snap-to-collapse, persistence
Clamp to `[minPx, maxPx]` each frame; below a threshold (e.g. < min/2) **snap to a collapsed width** and flip an `aria-expanded`-equivalent state. Persist the final size on `pointerup` (not per-frame) to **`localStorage`** keyed by a stable id; rehydrate on mount, ideally before paint to avoid layout shift. Prefer storing a **ratio/percentage**, not raw pixels, so the layout survives viewport changes.

## Library landscape vs custom hook
- **react-resizable-panels** (bvaughn): the de-facto standard, ~3.4M weekly dl, flexbox-based, gives ARIA live announcements, keyboard, SSR, collapsible, and `autoSaveId` localStorage persistence for free. It is the engine behind shadcn/Radix `Resizable`. Heaviest of the "lean" options but well-maintained.
- **allotment**: a literal port of VS Code's split-view; pixel-perfect VS Code look, browser-only, heavier.
- **react-split-pane**: older, larger API surface, less maintained.

## Recommendation for AKIS
**Write a small custom `useSplitPane` hook (~80–120 LOC, zero deps).** AKIS only needs one 2-pane horizontal split and explicitly avoids heavy deps for a self-hostable lean bundle. A custom hook over CSS-Grid + a CSS variable + Pointer Events capture + rAF + a localStorage ratio gives you everything react-resizable-panels offers for this single use case at a fraction of the bytes, with no transitive dependency or version-churn risk. Reach for **react-resizable-panels only if** the layout grows to nested/multi-pane groups where its constraint solver and persistence engine earn their weight.

## A11y contract for the drag handle (the hard part to get right)
The handle element MUST be a focusable **`role="separator"`** (`tabindex="0"`) carrying the **Window Splitter** pattern:
- `aria-valuenow` = current primary-pane position (0–100), with `aria-valuemin` (typ. 0) and `aria-valuemax` (typ. 100), updated live on every resize.
- `aria-orientation="vertical"` for a vertical bar splitting left/right panes.
- `aria-controls` → id of the primary (resized) pane; `aria-label` (or `aria-labelledby` if the pane has a visible heading), e.g. "Resize chat/preview panels".
- **Keyboard:** Left/Right Arrow move a vertical splitter by a fixed step; **Enter toggles collapse** (collapse if open, restore previous position if collapsed); optional Home = minimize, End = maximize. Keep keyboard steps clamped to the same min/max and keep `aria-valuenow` in sync.
- Provide a visible focus ring and a comfortable hit-target (handle visually thin, hit-area ≥ ~8–12px). On keyboard resize, persist the same way as pointer resize.

## Sources
- [Window Splitter Pattern — W3C WAI-ARIA APG](https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/)
- [ARIA: separator role — MDN](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/separator_role)
- [react-resizable-panels — GitHub (bvaughn)](https://github.com/bvaughn/react-resizable-panels)
- [react-resizable-panels — npm](https://www.npmjs.com/package/react-resizable-panels)
- [Resizable — shadcn/ui (built on react-resizable-panels)](https://ui.shadcn.com/docs/components/radix/resizable)
- [allotment — GitHub (johnwalley)](https://github.com/johnwalley/allotment)
- [split-views — framework-agnostic, Pointer Events + CSS-variable sizing (GitHub)](https://github.com/wutility/split-views)
- [Implementation: Resizable Grid — Jérôme Beau (Medium)](https://javarome.medium.com/implementation-resizable-grid-49ba6f1a2396)
- [grid-template-columns — MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/grid-template-columns)
- [npm trends: allotment vs react-resizable vs react-split-pane](https://npmtrends.com/allotment-vs-react-resizable-vs-react-split-pane-vs-react-splitter-layout)


### Lens 4 — AKIS grounding

# Grounding Brief — Preview as a resizable right drawer + device toggle (RESEARCH LENS 4)

Breadth searched: `ChatStudio.tsx`, `PreviewPanel.tsx`, `CodeBrowser.tsx` in full; grepped every `previewOpen`/`mobileTab`/grid/i18n preview key across `src/chat/` + `src/components/` + `src/i18n/catalog.ts`.

## (a) Current layout / state machine — where previewOpen & collapse live

The studio is a **two-column CSS-grid split**, not a drawer. All layout state is in `ChatStudio.tsx`:

- `previewOpen` boolean, `useState(true)` — open-by-default — `ChatStudio.tsx:73`. Toggled at `:446` (header chevron) and `:470` (collapsed-strip click).
- `mobileTab: 'chat'|'preview'`, `useState('chat')` — `:78`. Mobile-only pane switcher (`lg:hidden` tablist `:406-423`); desktop classes are no-ops via `chatPaneMobile`/`previewPaneMobile` (`:399-400`).
- The grid container `:427` swaps `grid-template-columns` with a 300ms transition: when `hasRun && previewOpen` → `lg:grid-cols-[minmax(0,1fr)_minmax(30rem,46%)]` (xl 48%, 2xl 50%); when collapsed → `lg:grid-cols-[minmax(0,1fr)_4rem]`; no run → `grid-cols-1`.
- The preview lives in an `<aside>` `:438-485` (a **grid cell**, in-flow, pushes the chat). `previewOpen` renders the full rail (TrustReportCard, PublishButton, AgentWriteProposals, ExternalWriteCard, then `<PreviewPanel>` `:465`); `!previewOpen` renders the 4rem vertical-label strip `:468-483`.
- `hasRun = !!activeSessionId` `:396` gates the whole rail.

`PreviewPanel.tsx` owns the **inner** tab machine: `tab: 'preview'|'code'|'trust'` `:27`, derived `activeTab` auto-recovery `:46`, `showTablist` `:47`, the iframe `:163-165`, letterbox `max-w-[1100px]` `:164`, boot watchdog `BOOT_SLOW_MS=125_000` `:23/:33-38`, `canRun` is passed in (computed `ChatStudio.tsx:326`).

## (b) Exact files:lines to change for a resizable right drawer (closed-by-default, slide-in) + device toggle

1. `ChatStudio.tsx:73` — flip default to `useState(false)` (closed-by-default). NOTE: this collides with the auto-preview effect `:306-314` which boots the process but does **not** open the rail — add `setPreviewOpen(true)` there (or a "preview ready" SSE) so a finished build slides the drawer in.
2. `ChatStudio.tsx:427` — replace the grid-template swap. For a drawer, the chat column should be full-width (`grid-cols-1` always, or keep grid but make the aside non-grid). The drawer becomes a fixed/absolute overlay sibling, not a grid cell.
3. `ChatStudio.tsx:438-485` — the `<aside>`. Convert from in-flow grid cell to a slide-in drawer: `fixed right-0 top-0 h-full` (or `absolute` within a `relative` studio root `:402`) + `translate-x-full → translate-x-0` transition keyed on `previewOpen`, with a width that's resizable. Add a backdrop scrim for mobile. The collapsed 4rem strip `:468-483` is replaced by a persistent "Open preview" trigger (a floating button) — must remain reachable when closed.
4. **Resize handle** — new: a drag handle on the drawer's left edge writing a `previewWidth` number state (new `useState`, persist to localStorage like `recentBuilds.ts`). The current `minmax(30rem,46%)` widths `:427` become the clamp bounds.
5. **Device toggle** — new state `device: 'desktop'|'tablet'|'mobile'` in `PreviewPanel.tsx` (alongside `tab` `:27`), rendered as a segmented control next to the Run/verified cluster `:90-112`. It drives the iframe wrapper width `:163-164`: replace the fixed `max-w-[1100px]` with a device-mapped max-width (e.g. desktop=1100px, tablet=768px, mobile=390px) on the `mx-auto` container. Keep `mx-auto` letterboxing.
6. New i18n keys in **both** catalogs (`catalog.ts` EN ~`:190` block + TR ~`:958` block): `preview.device.desktop/tablet/mobile`, `preview.open`, `preview.resize`. Existing reusable keys: `preview.collapse/expand` `:190-191`, `preview.collapsed` `:192`.

## (c) SACRED constraints — must NOT change

- **Iframe sandbox** `PreviewPanel.tsx:165`: `sandbox="allow-scripts allow-forms allow-popups"` — deliberately **NO `allow-same-origin`** (comment `:154-158`). Device toggle only resizes the wrapper; never touch the sandbox attr or `src` allowlist (`embeddable = url.startsWith('/preview/')` `:57`).
- **Single-conversation chat spine**: the `<section>` chat at `:428-435` and `AkisChat` `key={threadKey}` `:371` must stay at the same tree position (comment `:391-395`) — REMOUNT discards the just-appended inline run marker. A drawer overlay sibling is fine; do NOT move the chat into a conditional branch.
- **5 gates render in chat**: gate cards are inside `AkisChat`/`RunBlock`, not the rail — keep them there; the drawer holds only preview/trust/publish/proposals.
- **SSE/fold**: `activeView` comes from the active RunBlock's single reporter (`onActiveView` `:384`, comment `:80-82`). Don't add per-event setState in the drawer.
- **Gate-safety**: FE holds no gate authority — the device toggle and resize are pure view state; `canRun` `:326`/`runApp` `:286` flow unchanged.

## (d) Double-scroll root cause + minimal fix

Root cause is a **chain of nested `overflow-y/-auto` ancestors**, not CodeBrowser alone:
- The `<aside>` is `overflow-y-auto` — `ChatStudio.tsx:439`.
- Inside it, `PreviewPanel` is `flex h-full flex-col` `PreviewPanel.tsx:64`, and when the Code tab is active it mounts `CodeBrowser` `:124`, which is `h-full flex flex-col` `CodeBrowser.tsx:45` with its own inner `overflow-auto` viewer `:86` and `overflow-y-auto` file list `:55`.

So CodeBrowser establishes its own internal scroll region (correct), but it sits inside the `aside`'s `overflow-y-auto` — the aside also scrolls because the rail's stacked siblings (TrustReportCard/PublishButton/proposals/PreviewPanel `:455-465`) overflow it. Two scrollbars appear: the aside's and CodeBrowser's inner viewer.

Minimal fix: the rail's scroll should live on the **content wrapper**, not double up with the panel's own `h-full` regions. Either (1) when the active inner tab is `code`/`trust`, the panel manages its own scroll, so the `aside` `overflow-y-auto` `:439` double-counts — change the aside to `overflow-hidden` and give the *stacked cards group* its own single `overflow-y-auto` wrapper, leaving `PreviewPanel`/`CodeBrowser` `h-full` regions to scroll internally; or (2) simplest: make `PreviewPanel`'s root `min-h-0` so its `flex-1` children own the scroll, and switch `aside:439` from `overflow-y-auto` to `overflow-hidden flex flex-col` with the cards in a `min-h-0 overflow-y-auto` sub-div. The load-bearing edit is `ChatStudio.tsx:439` (`overflow-y-auto` → `overflow-hidden` + an inner scroll wrapper); CodeBrowser already scrolls correctly on its own (`:53,:55,:86`) and needs no change.

## 14. Independent fresh-review reconciliation — FINAL v1 build scope

A zero-context independent senior review (2026-06-09) returned **proceed-with-changes**. Accepted below; this section SUPERSEDES any conflicting text in §1–§13 and defines the **v1 build scope** (YAGNI-trimmed). Confirmed solid (do not relitigate): gate-safety CLEAN, iframe sandbox preserved, chat-spine tree-slot, zero-dep `useResizable`, W3C splitter a11y, all file:line groundings accurate.

### Accepted corrections (supersede prior)
- **i18n is NOT a blocker (withdraws C1/Feas-HIGH framing).** The repo HAS interpolation: `fill(t(key), vars)` (`AgentWriteProposals.tsx:185`, `{n}` templates + parity test). The width readout = `fill(t('preview.device.width'), { n: String(width) })` OR JSX composition — both fine.
- **H2 — auto-open on `view.preview.ready` (corrects §7).** Open when `view.preview.ready === true` (URL guaranteed embeddable, `viewModel.ts:123/126`), NEVER on `starting`.
- **H1 — explicit drawer height budget (corrects §6/C2; §6 single-wrapper text is void).** Drawer `flex flex-col h-full`; region A (gate cards) `shrink-0 overflow-y-auto max-h-[50vh]`; region B (PreviewPanel) `flex-1 min-h-0`; add `min-h-0` to PreviewPanel root (`:64`) and RELAX the iframe band clamp (`:136`) to a small floor inside the bounded parent. Live-verify: ONE scrollbar on Kod.
- **H3 — mobile overlay reuses `ModelPicker.tsx` a11y verbatim:** `role=dialog aria-modal`, Escape, focus-into-on-open, focus-restore-on-close, body scroll-lock (`overscroll-behavior:contain`).
- **M5 — #35 reopen:** SEPARATE `drawerAutoOpened` ref pre-seeded in `seedRun` (`:152`) alongside `autoRan`; reopen = already-opened, fresh `ready` still fires once.
- **M1 — persistence guards:** on `<lg` ignore persisted `open:true` (require FAB tap); re-clamp rehydrated `ratio` vs CURRENT viewport before paint (28rem chat floor).
- **M2 — closed iframe:** gate iframe mount on first-open (no invisible preview boot); stays mounted after.
- **M3 — default ratio:** breakpoint-derived (46/48/50%) until first drag, then persisted flat ratio wins.
- **M4 — toolbar budget:** device buttons icon-only + px-badge readout; DeviceToggle hidden unless `activeTab==='preview'`.
- **L1** `aria-valuenow`=drawer width % + localized `aria-valuetext` (via `fill`). **L2** snap only on `pointerup`. **L3** desktop edge-tab keeps verified/unverified dot. **L5** DeviceFrame WRAPS the existing `<iframe>` verbatim (`sandbox`+`allow="clipboard-write"`, no `allow-same-origin`).

### v1 build scope (ship this)
**IN:** drawer shell (chat-first; desktop push-split via `paddingRight:var(--preview-w)`; mobile full-screen overlay w/ ModelPicker a11y); `useResizable` (CSS-var + pointer-capture + rAF + persisted ratio + keyboard/ARIA splitter); device toggle = **Responsive (default) · Mobil 390 · Masaüstü/Fit** (iframe LOGICAL width; Desktop = `min(1280,paneWidth)` + horizontal scroll when narrower); two-region height fix; auto-open on `ready`; the `drawerAutoOpened` #35 ref; persistence + viewport re-clamp.
**DEFERRED to v2 (intentional cut):** rotate (w↔h), Tablet 768 preset, desktop `ResizeObserver` scale-to-fit (RO-loop risk). ~60% of the proposed surface for ~95% of the value.

