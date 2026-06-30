# AKIS Studio — UX/UI Audit (build-in-progress focus)

Date: 2026-06-08
Scope: READ-ONLY audit of `frontend/src` — the chat-first Studio, the build/run rendering, the live-preview rail, the metrics strip, the two-column layout. No files changed.
Method: traced the real composition seam (greeting → user spec → `SpecCard` → run-marker → `RunBlock`) and every component it mounts. Every finding cites `file:line`.

---

## Summary

The Studio is a single conversation in the LEFT column with a live-preview rail on the RIGHT. The architecture is sound (one scroll, inline run-blocks, gate-safe). The problem the owner is feeling is **spatial / hierarchical, not structural**:

- During a build, the actually-interesting content (Proto writing code, Critic verdict, retry counters, Verify) is rendered as bubbles **at the bottom of the left column, below a `max-h-[60vh]` spec card** (`RunBlock` mounted at its run-marker slot in `AkisChat.tsx:461`, after the `SpecCard` at `AkisChat.tsx:110`). To see it you must scroll past the spec.
- The auto-scroll (`AkisChat.tsx:248-252`) yanks the viewport to the bottom on every rAF-coalesced fold while the build streams, which reads as "kayıyor / did we freeze".
- The RIGHT column is a large dark "Run the app to see it live here" empty state (`PreviewPanel.tsx:226-235`, `preview.empty`) for the ENTIRE build, occupying 46–50% of the viewport (`ChatStudio.tsx:427`) while the live action is cramped bottom-left.
- The metrics strip (`TestStats.tsx`) sits at the very bottom of that empty rail showing four `—` placeholders (`TestStats.tsx:30-33`), disconnected from anything happening.

The single highest-leverage fix: **during an in-flight build, fill the otherwise-empty preview rail with the live agent activity** (a "Build progress" surface), and **stop auto-scrolling the left column during a streaming build**. Everything else is polish on top of that.

---

## The owner's 3 complaints — concrete fixes

### Complaint #1 — "Live activity is buried at the bottom-left, under a huge spec card; the view slides to it and looks frozen"

**Root cause (two parts):**

1. **Spatial burial.** The spine renders, in order: greeting bubble → the user's spec request → `AssistantMessage` containing the `SpecCard` → the `run` marker → `RunBlock`. The `RunBlock` (`RunBlock.tsx:129-159`) is therefore always *below* the spec card, which itself is `max-h-[60vh]` of scrollable markdown (`SpecCard.tsx:47`). On a laptop the spec card alone eats ~60% of the column height, so the live `RunPipeline` header + agent bubbles begin off-screen.
2. **Auto-scroll thrash.** `AkisChat.tsx:248-252` runs on every `[nodes, busy]` change and does `el.scrollTop = el.scrollHeight` whenever `stickToBottom.current` is true. `appendRun` (`AkisChat.tsx:271-274`) sets `stickToBottom.current = true` when the run starts, so during the build the column repeatedly jumps to the bottom. The `RunBlock`'s own streaming bubbles do NOT re-key `nodes` (they live in the child's `useLiveChat`), so the auto-scroll effect does not re-fire per agent event — but the spec card height + the initial jump is enough to make the activity feel like it appears, slides away, and stalls.

**Fix A (primary, ties into #2) — surface live activity in the empty preview rail.** During an in-flight build, render the agent activity in the RIGHT rail instead of (or in addition to) bottom-left. See the Recommended redesign below. Effort **M**.

**Fix B (cheap, do regardless) — collapse the spec card once its build has started.** When `isStarted` is true (`SpecCard.tsx:25`), the spec is no longer the thing the user is reading — it has been approved and is building. Collapse the markdown body to a one-line summary + a "Show spec" toggle so it stops eating 60vh above the activity. Change `SpecCard.tsx:47` to conditionally render a collapsed header when `isStarted`. Effort **S**.

**Fix C — pin the active run to the top of the visible area while building.** Add a `scrollIntoView({block:'start'})` on the active `RunBlock`'s header the moment it mounts, instead of scrolling the column to its very bottom. The run header (`RunPipeline`) then sits at the top of the viewport and the bubbles grow downward into view — the natural "watch it work" reading order. Anchor: give the active `RunBlock`'s `<section>` (`RunBlock.tsx:130`) a ref and, in `AkisChat`, after `appendRun`, scroll that section's top into view rather than bottom-pinning. Effort **S/M**.

### Complaint #2 — "The big empty preview dominates; the action should be prominent, the empty preview shouldn't"

**Root cause.** The rail is unconditionally `minmax(30rem,46%)`/`48%`/`50%` (`ChatStudio.tsx:427`) the instant `hasRun` is true, but `PreviewPanel` only has something to show once the app boots — which on a real build is *after* code is written + verified. For the whole producing/verifying phase the rail is the `preview.empty` dark band (`PreviewPanel.tsx:136` container + `:226-235` empty state). So 46–50% of the screen is dead during the most interesting minutes.

**Fix (primary) — make the rail context-aware:**

- While the run is **in-flight** (`view.status === 'running' | 'started'`, the same `inFlight` already computed in `RunPipeline.tsx:81`), render a **Build progress** panel in the rail: the agent roster with live presence, the current agent's streaming bubbles, the trust ledger, retry counters, Verify result as it lands. This reuses `foldRunBubbles` output that the `RunBlock` already has — see redesign for the lift.
- Only **swap to the live app** once `view.preview.url`/`ready` exists (it auto-runs on done, `ChatStudio.tsx:306-314`).
- Optionally, keep the rail **narrower while building** (e.g. `lg:grid-cols-[minmax(0,1fr)_minmax(26rem,40%)]`) and widen to 46–50% only once a preview URL exists, so the conversation keeps primacy until there is a real app to frame.

This directly inverts the owner's complaint: the action moves into the prominent right pane during the build; the empty preview no longer dominates because it is no longer empty. Effort **M** (the data is already folded in `RunBlock`; the work is lifting one render into the rail).

### Complaint #3 — "TESTS RUN / RESULT / SCENARIOS / P95 show — placeholders during build, feel disconnected"

**Root cause.** `TestStats` (`TestStats.tsx:18-35`) always renders the 4-cell grid; until a `verify` event lands, `stats.ran` is false so all four cells show `'—'` (`TestStats.tsx:30-33`). It is pinned to the BOTTOM of the preview rail (`ChatStudio.tsx:465` → `PreviewPanel.tsx:256`), far from any activity, so four dashes read as "broken / nothing happening".

**Fixes (pick per appetite):**

- **S** — Hide the strip entirely until `stats.ran` is true, OR show a single "Verification pending" line instead of four `—` cells. Guard at `TestStats.tsx:18` (early return / conditional grid) — but the comment at `:15-17` explains the 4-cell-always was chosen to avoid layout jump when results fill in. That trade-off was reasonable when the strip lived in a results view; in a build-in-progress rail the four dashes are worse than a reflow.
- **M (better)** — Make the strip **live**: drive `tests.run` from the in-flight signal. Trace's `run_tests` tool-call (visible in `foldRunBubbles` agent tools, `chatModel.ts:71`) means "tests are running now" → show a pulsing "running…" in the RESULT cell instead of `—`, then fill the real number on the `verify` event. This turns the strip from a dead placeholder into a live verification indicator that belongs in the build view.
- Either way, **co-locate** it: when the rail shows Build progress (Fix #2), put the verification cells inside that panel, directly under the Verify/Trace activity, so the numbers attach to the thing producing them.

---

## Prioritized findings

### HIGH

| # | Problem | Why it hurts | Fix (file:line · approach) | Effort |
|---|---------|--------------|----------------------------|--------|
| H1 | **Live build activity is buried below the spec card, bottom-left** (`RunBlock` at `AkisChat.tsx:461` sits after `SpecCard` `SpecCard.tsx:47` `max-h-[60vh]`). | The interesting work starts off-screen; user must scroll; reads as frozen. | Collapse spec card once `isStarted` (`SpecCard.tsx:25,47`) **and** lift activity into the rail (see redesign). | M |
| H2 | **Preview rail is a large empty dark band for the whole producing/verifying phase** (`ChatStudio.tsx:427` reserves 46–50%; `PreviewPanel.tsx:226-235` empty state). | Dead space dominates the screen while the action is cramped elsewhere. | Render Build-progress in the rail while `inFlight`; only swap to the app iframe when `view.preview.url` exists; keep rail narrower until then. | M |
| H3 | **Auto-scroll yanks the column to the bottom on build start / busy changes** (`AkisChat.tsx:248-252`, `appendRun` `:271-274` re-arms `stickToBottom`). | The "kayıyor" feeling; disorienting; the header/roster you want to watch slides away. | Scroll the active run's *top* into view on mount (`RunBlock.tsx:130` ref) instead of column bottom; do NOT re-arm bottom-stick when a run starts mid-read. | S/M |
| H4 | **Metrics strip shows four `—` during build, disconnected at rail bottom** (`TestStats.tsx:30-33`, mounted last `PreviewPanel.tsx:256`). | Reads as broken; offers no live signal. | Hide until `ran`, or drive a live "running…" from Trace's `run_tests` tool-call; co-locate under Verify activity. | S→M |
| H5 | **No persistent "build is running" affordance at the top of the frame.** The only live indicators are the roster dots in the header (`ChatStudio.tsx:357-365` → `AgentRoster.tsx`) and the `StartingElapsed` ticker (`ChatStudio.tsx:47-61`) which disappears once the run marker lands. | After the "starting" card vanishes there is no always-visible "building… (elapsed)" anchor; if the activity is scrolled away the studio looks idle. | Add a slim sticky build-status bar (agent + phase + elapsed + Stop) at the top of the chat column or the header while `inFlight`. Reuse `inFlight` (`RunPipeline.tsx:81`) and the elapsed-ticker leaf pattern. | M |

### MEDIUM

| # | Problem | Why it hurts | Fix (file:line · approach) | Effort |
|---|---------|--------------|----------------------------|--------|
| M1 | **Stop control is hard to find** — it rides the right edge of the trust-headline row *inside* the run-block header (`RunPipeline.tsx:93-98`), which is itself below the spec card. | The primary "this is taking too long, stop it" action is buried with the activity. | Surface Stop in the sticky build-status bar (H5) so it's always reachable while in-flight. | S |
| M2 | **Two competing "running" empty/transition states with different visual languages.** The "Workflow is starting" card is teal (`ChatStudio.tsx:336-346`); the preview empty is muted slate (`PreviewPanel.tsx:226`); the booting spinner is teal (`:195-198`). | Phase transitions (starting → building → booting → live) look like unrelated screens, not one continuous build. | Unify into one Build-progress surface with a phase indicator (Planning → Building → Verifying → Booting → Live) driven off `view.status`/lanes; retire the standalone starting card once the rail owns it. | M |
| M3 | **Agent roster header doesn't convey overall progress, only per-agent dots.** `AgentRoster.tsx:46-65` shows 5 chips with status dots; no phase/elapsed/"3 of 5 agents done". | Glanceability is low — you can't tell at a glance how far along the build is. | Add a thin progress line or "Building · Proto · 02:14" summary to the roster row, or a step counter derived from `presenceOf` results. | S/M |
| M4 | **`SpecCard` markdown can be very long** (`max-h-[60vh]` scroll, `SpecCard.tsx:47`) and it stays full-size forever after approval. | Pushes everything below it down permanently; the #1 burial cause. | Collapse to a summary chip after `isStarted` (same as H1 Fix B); keep "Show spec" to re-expand. | S |
| M5 | **Agent bubbles use a generic `border-white/10 bg-white/[0.03]` card** (`ChatThread.tsx:60`); only the avatar carries role tint (`ChatThread.tsx:17-23,29`). | The conversation reads monochrome; hard to scan which agent is which at a distance; low visual interest. | Tint the bubble's left border or a 2px accent stripe per role using the existing `ROLE_TINT` map (`ChatThread.tsx:17-23`). Subtle, on-brand. | S |
| M6 | **Tool lines render as raw `✓`/`✗`/`…` text rows** (`ChatThread.tsx:68-75`) with no grouping or iconography beyond a colored word. | A multi-tool agent turn is a wall of tiny text; the live "working" state is easy to miss. | Render tool lines as small chips/rows with a leading spinner while `ok===undefined`; keep the localized label. | S |
| M7 | **Collapsed preview rail (`4rem`) is a desktop-only dead-end with a vertical label** (`ChatStudio.tsx:467-483`). | Niche affordance; while building it would hide the very activity we want to surface. | When building + rail shows Build-progress, suppress the collapse toggle (nothing to gain by hiding live activity); keep collapse only for the live-app phase. | S |
| M8 | **Verify/CodeReview/Done bubbles are visually similar single-line pills** (`ChatThread.tsx:151-223`). | The "milestone" moments (verified, shipped) don't feel like milestones — they read like ordinary rows. | Give Done/Verify a slightly larger, celebratory treatment (the Done bubble already has a gradient `:218`; extend to a full-width divider or a check-burst). | S |

### LOW

| # | Problem | Why it hurts | Fix (file:line · approach) | Effort |
|---|---------|--------------|----------------------------|--------|
| L1 | **`min-h-[32rem]` floor + `h-[calc(100dvh-8.5rem)]`** (`ChatStudio.tsx:402`) hard-codes the header offset; if the top nav wraps (it can — `App.tsx:94` `flex-wrap`) the math is off and the frame can overflow. | Edge-case layout drift on narrow/zoomed viewports. | Use a flex/grid parent that measures available height instead of a magic `8.5rem`. | M |
| L2 | **Composer area stacks model chip + usage meter + suggestions + input** (`AkisChat.tsx:565-599`) — dense, and during a build it's all still visible/active. | Visual noise at the bottom while the user just wants to watch the build. | While in-flight, de-emphasize/hide the suggestion chips + model chip (the user isn't picking a model mid-build). | S |
| L3 | **`preview.empty` copy is imperative even before any app can run** (`preview.empty` "Run the app to see it live here", `PreviewPanel.tsx:228`). | During a build there is nothing to run yet — telling the user to "run the app" is misleading. | Show a build-phase message ("AKIS is building your app…") while in-flight; only show the Run CTA once `canRun`. | S |
| L4 | **Trust ledger label is `text-[9px]` uppercase** (`RunPipeline.tsx:42`) and tokens are `text-[10px]` (`:46`). | Below comfortable legibility; the "moat made legible" is nearly illegible. | Bump to `text-[10px]`/`text-[11px]`; the rail has room. | S |
| L5 | **`AgentRoster` status text shown twice** — `sr-only` (`AgentRoster.tsx:58`) and a visible `sm:inline` span (`:59`). | Minor redundancy; the visible status duplicates the dot's meaning and crowds the chip. | Keep the `title`+`sr-only`; drop the visible status word, or show it only on hover. | S |
| L6 | **No skeleton/placeholder for the run-block before the first event** — `RunBlock` renders `RunPipeline` with an `emptyView` and no bubbles (`RunBlock.tsx:140-157`); the bubble list is simply absent until events arrive. | A brief "nothing here" gap right after Approve. | Render a 1–2 line skeleton (Planning…) until the first `agent_start` folds. | S |
| L7 | **Color contrast on muted slate** — many secondary texts use `text-slate-400`/`text-slate-500` on `bg-white/[0.02]` (e.g. `RunPipeline.tsx:87` `text-slate-400`, `TestStats.tsx:11` labels). | Borderline WCAG AA on the dark cosmic background. | Nudge the dimmest secondary text up one slate step where it carries meaning. | S |
| L8 | **`scrollIntoView`/jump-to-latest pill is the only scroll aid** (`AkisChat.tsx:530-535`); no "jump to active build" affordance. | If the user scrolls up during a build, getting back to the live activity = generic "Latest", which lands at the very bottom (composer), not the run header. | Make the pill context-aware: while building, label/scroll it to the active run header, not the absolute bottom. | S |

---

## Recommended build-in-progress redesign (primary)

Goal: while a build is in flight, the **right rail shows the live build**, the conversation stays calm, and nothing slides.

**Layout (in-flight phase):**

```
┌──────────────────────────────┬───────────────────────────────┐
│ AgentRoster + "Building · Proto · 02:14" + Stop  (sticky)     │  ← H5/M1/M3
├──────────────────────────────┼───────────────────────────────┤
│ CHAT (left, calm)            │  BUILD PROGRESS (right)        │
│  greeting                    │   ▸ Phase: Building            │  ← M2 phase strip
│  user spec                   │   ▸ Trust ledger (proof)       │  ← RunPipeline ledger
│  ▸ Spec ✓ (collapsed chip)   │   ▸ Proto  ●working  ↻2        │  ← foldRunBubbles agent
│    [Show spec]               │   ▸ Critic  approved · 0 crit  │     bubbles, live
│                              │   ▸ Trace  running tests…      │  ← M6 live tool chips
│  (no auto-scroll)            │   ▸ Verify  ✓ 12 tests         │  ← H4 live verify
│                              │   TESTS RUN / RESULT / …       │  ← co-located, live
└──────────────────────────────┴───────────────────────────────┘
```

**Once the app boots** (`view.preview.url`/`ready`), the right rail swaps Build-progress → the live iframe (`PreviewPanel`), and the trust card / publish button appear as today (`ChatStudio.tsx:455-465`). The Build-progress can demote to a collapsed "View build log" disclosure.

**Implementation sketch (minimal, idiom-preserving):**

1. **Lift the active run's folded bubbles up.** `RunBlock` already computes `live.messages` + `live.view` (`RunBlock.tsx:65,150-157`) and the active run already reports `live.view` up via `onView` (`RunBlock.tsx:107-109` → `ChatStudio.tsx:384` `setActiveView`). Add a sibling `onMessages?(messages)` so the active run can also report its `live.messages` up to `ChatStudio`. (Keep the storm-safety contract: only the *active* run reports, one setState per frame — same cadence as `onView`.)
2. **In `ChatStudio`, render a `BuildProgress` panel in the rail when in-flight.** Gate on `status === 'running' || 'started'` (mirror `RunPipeline.tsx:81`). It renders `RunPipeline` (ledger/headline/Stop, already memoized) + the lifted `live.messages` via the shared `ChatBubble` renderers (`ChatThread.tsx:227`) — the SAME components, no re-implementation, gate-safe (reuse the same bare `approve/confirm` callbacks already wired at `ChatStudio.tsx:267-272`). Swap to `PreviewPanel` only when `view.preview.url` exists.
3. **Collapse the spec card after `isStarted`** (`SpecCard.tsx:25,47`) to a one-line chip + "Show spec".
4. **Stop bottom-pinning during a build.** In `AkisChat.tsx:248-252`, when the active run is in-flight, don't `scrollTop = scrollHeight`; instead keep the user where they are (the activity is now in the rail, which has its own scroll). On run start, `scrollIntoView({block:'start'})` the run header once instead of re-arming `stickToBottom` (`appendRun` `:271-274`).
5. **i18n** — add keys to BOTH EN+TR catalog blocks for any new strings ("Build progress", phase labels, "Show spec", "AKIS is building…"). Never leak raw English.

**Why this respects the sacred rules:**
- ONE conversation: the left column is still the single chat; the rail is a *projection* of the active run, not a second chat or the retired 5-stage strip. Gates still render as the inline `GateBubble` (shown only while awaiting) wherever the bubbles render.
- Gate-safety: the rail reuses the exact bare `approve/confirm/resolveCritic/retryRun` callbacks; mints nothing.
- SSE perf: one reporter (active run), one rAF-coalesced fold, memoized children — the lifted `onMessages` follows the existing `onView` cadence; no per-event setState storm.

**Smaller alternative (if the lift is too much for now):** do H1-Fix-B (collapse spec card) + H3 (scroll active run header to top, not bottom) + H4 (hide/animate metrics) + H5 (sticky build bar). That alone resolves the "buried + frozen" feeling without moving activity into the rail. The rail empty-state would still be dead space (#2), so the full redesign is preferred.

---

## Notes for live verification (dev server hot-reloads)

After any of these changes, drive a real build and watch: (1) the moment Approve is clicked, the active run header should appear at the TOP of the visible area, not the bottom; (2) the right rail should fill with live agent activity, not the empty dark band; (3) the column should not auto-slide while Proto streams; (4) the metrics cells should not show four `—` while idle. Use the Brave automation profile per machine rules.

---

## Addendum (2026-06-08, owner feedback round 2) — the chat "container" doesn't read as a real chat surface

**Owner's words (paraphrased):** "As the chat extends downward the container around the chat keeps the same look and the text crosses over the lines/borders — wouldn't a proper chat screen be better? Research the standards for this."

**Honesty caveat:** part of the visual "text crossing the border" the owner saw in that moment was an artifact of the screenshot tooling temporarily relaxing the layout (the capture step expands `max-h`/`overflow` to grab full-height content, which makes children spill past their bordered box). That specific spill is NOT a product bug. But the underlying complaint — the conversation column doesn't read like a designed chat surface — is real and worth fixing. Treat the artifact and the real issue separately; verify in a clean (un-instrumented) page before sizing the work.

**Real, code-level issues behind "doesn't look like a proper chat":**

1. **No bounded reading measure.** Bubbles stretch to the full column width (`ChatThread.tsx:60` region; `ChatBubble`), so on a wide window a single assistant line runs 100+ chars edge-to-edge — past the comfortable 60–75ch measure. A real chat caps bubble width (e.g. `max-w-[42rem]`/`max-w-[75ch]`) and aligns user vs assistant.
2. **Monochrome, unanchored bubbles.** Bubbles are a flat `bg-white/[0.03]` with only the avatar tinted (`ChatThread.tsx:60`); user and assistant turns are not visually differentiated (no side alignment, no role tint, no tail). This is what makes the column read as "a list of boxes" rather than a conversation.
3. **Fixed-height ancestors that clip rather than grow.** The spec card is `max-h-[60vh]` with internal scroll (`SpecCard.tsx:47`); nested scroll regions inside one scrolling column create the "container stays the same while content overflows" feel. A chat surface should have ONE scroll context; inner blocks grow naturally.
4. **Container chrome doesn't adapt to content.** The run/spec blocks keep a fixed bordered card look regardless of how much they contain, so long content visually butts against the border with uneven padding.

**Standards to apply (modern chat-surface conventions):**

- **One scroll context.** The conversation column scrolls; message blocks size to content (no nested `max-h` scrollers except for genuinely huge artifacts, which get an explicit "expand" affordance).
- **Bounded measure + alignment.** Cap bubble width to a readable measure; right-align + tint user turns, left-align assistant turns; consistent vertical rhythm (`gap-4`+) between turns.
- **Role identity.** Per-role accent (reuse the existing `ROLE_TINT` map) as a left border/avatar ring so AKIS/Scribe/Proto/Trace/Critic are distinguishable at a glance.
- **Generous, even padding** inside bubbles (`px-4 py-3`), with text never touching the border; rounded, soft-shadow cards with a subtle hover.
- **Sticky composer** pinned to the bottom of the column with a fade/gradient mask so messages scroll under it; autosizing textarea.
- **Empty/typing states** that look intentional (typing indicator, not a bare spinner).

**Suggested scope:** a focused pass on `ChatThread.tsx` / `ChatBubble` (measure cap + role tint + alignment + padding) and the single-scroll cleanup tied to H1-Fix-B (collapse the in-progress spec card). Low risk, high "feels like a real product" payoff. Effort **M**. (Cross-refs: M5/M6 in the table above already flag the monochrome bubbles + missing role tint.)
