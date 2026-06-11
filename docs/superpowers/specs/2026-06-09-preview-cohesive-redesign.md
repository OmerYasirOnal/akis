# AKIS Studio — Holistic Chat+Preview Redesign (cohesive / bütüncül)
_Source: akis-preview-cohesive-redesign workflow (research → design → adversarial review), 2026-06-09._

> **Scope note (post-review):** Phase 1 = FE-only (drawer anti-jumble + chat foreground + typography/copy/live-elapsed-timer/auto-scroll). The 'live agent message substatus from notes[last]' in the design below is **NOT feasible** as written (feasibility HIGH finding — see Reviews): subagents are non-streaming and emit no per-step text. Real live agent messages = Phase 2 backend work.

---

## Design

I now have complete grounding across all files plus the exact i18n keys. I confirmed the grounding brief's claims against real code: `previewW` resolves to `'0px'` when closed (ChatStudio.tsx:478), the aside has `width: var(--preview-w)` with no `overflow-hidden` (PreviewDrawer.tsx:198-201), the edge-tab is `z-40` vs aside `z-30` (PreviewDrawer.tsx:269/201), the chat surface is `bg-white/[0.02]` (ChatStudio.tsx:526), `AgentBubble` never renders `m.notes` (ChatThread.tsx:84-97), and the only live ticker is `StartingElapsed` (ChatStudio.tsx:50-64). The TestStats grid uses `sm:grid-cols-4` keyed off viewport not drawer width (TestStats.tsx:58) — "Çalışan test" (catalog.ts:1080) is the "ÇA TEST" clip.

Now I'll write the design doc as my deliverable.

I have everything needed. Here is the complete design doc.

---

# AKIS Studio — Holistic Chat + Live-Preview Redesign ("bütüncül")

**Scope:** FRONTEND-only. Preserves the sacred constraints: gates render in chat & are server-minted, the iframe sandbox tag is untouched, the SSE fold-per-rAF is reused (no new SSE semantics), `key={threadKey}` remount discipline holds (the drawer stays an absolute *sibling* of the chat `<section>`, never a wrapper).

---

## 1. Diagnosis recap (reported issue → root cause, file:line)

| # | Reported symptom | Root cause |
|---|---|---|
| 1 | Close "✕" persists when the drawer is CLOSED | `previewW` resolves to `'0px'` when `!previewOpen` (`ChatStudio.tsx:478`); the `<aside>` is `width: var(--preview-w)` (`PreviewDrawer.tsx:198`) with **no `overflow-hidden`** (`:201`). At width 0, `translateX(100%)` travels 0px, so the absolutely-positioned ✕ header (`:236`) paints at the right edge with nothing to clip it. The slide-away only works at non-zero width. |
| 2 | Right-side jumble (edge-tab + drawer + "ÇA TEST" clip) | Three stacked faults. (a) Edge-tab is `z-40` (`PreviewDrawer.tsx:269`) while the aside is `z-30` (`:201`); guarded only by `{!open}` (`:259`), but the aside animates over 300ms (`:201`), so mid-transition both can co-exist. (b) `<lg` the push-split is off (`lg:flex`/`lg:[padding-right]`) so the `absolute` drawer overlays the chat with no `overflow-hidden` → region-B bleed. (c) "ÇA TEST" = the TR label `'Çalışan test'` (`catalog.ts:1080`) clipping in the 4-col grid `grid-cols-2 sm:grid-cols-4` (`TestStats.tsx:58`) — `sm:` keys off the *viewport*, so a narrow drawer on a wide screen still forces 4 columns. |
| 3 | Chat doesn't read as a foreground surface | The chat `<section>` is `bg-white/[0.02]` over near-black with a 6%-opacity glow (`ChatStudio.tsx:526`); 2% white is effectively invisible, so the conversation melts into the page. The inner column adds no surface of its own (`:529`). |
| 4 | Auto-scroll during a build | Confirmed *not* a bug but underspecified. `appendRun` sets `stickToBottom=false` and scrolls the run header to top (`AkisChat.tsx:329-333, 289-301`). Live agent bubbles render inside `RunBlock`'s own `useLiveChat` (`RunBlock.tsx:65`) and never mutate `AkisChat.nodes`, so the `[nodes, busy]` auto-scroll (`:283`) never re-fires — the view does not follow streaming activity. |
| 5 | What agents render while working | `agent_start` → an `AgentBubble` with a pulsing dot + `chat.working` ("çalışıyor…", `ChatThread.tsx:82`); `tool_call` → "Kod yazılıyor …✓" (`:84-91`); `text` events are folded into `m.notes` (`chatModel.ts:77-82`) but **`AgentBubble` never renders `m.notes`** — the real streamed prose is captured and discarded. No live timer; the duration is static, written once on `agent_end` (`chatModel.ts:67` → `metricsBadge`). |
| 6 | Fonts/sizes underdeveloped; no Copy; no live timer | Inconsistent `text-sm`/`text-xs`/`text-[10px]` mix (`ChatThread.tsx:77,87,96`); Copy exists only on AKIS plain replies (`AkisChat.tsx:138`) + preview URL; the only live ticker is `StartingElapsed` (`ChatStudio.tsx:50`), which dies once the run marker lands. |

---

## 2. Holistic layout — one product, two zones

**Mental model (the competitor consensus):** the chat is the *persistent anchor spine*; the preview is the *guest* that appears beside it. There is exactly **one primary split** and exactly **one open/close source of truth**.

### 2a. The foreground chat surface
The shell keeps its structure (`relative flex … lg:h-[calc(100dvh-8.5rem)]`, `ChatStudio.tsx:508-512`) — sacred. We raise the chat `<section>` from a ghost to a clear foreground container:

- Surface: `bg-slate-900/60` (replaces `bg-white/[0.02]`), border `border-white/12`, `rounded-2xl`, `backdrop-blur-md`, and a contained inset top-light `shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_8px_40px_rgba(0,0,0,0.45)]` (replaces the diffuse violet page-glow that leaked outward). This gives the "place you talk" a distinct elevation against the rendered-app white that will sit to its right.
- Measure: the centered column already caps at `max-w-4xl…6xl` (`:529`) — keep, but raise vertical rhythm to `gap-4 py-5` so bubbles breathe.

### 2b. The preview drawer — one surface, one affordance

**Single state, single control.** The drawer's open/close is owned solely by `useResizable.open` (already the case). The redesign makes the *paint* match the *state* so there can never be an orphan control:

- **The ✕ lives INSIDE the drawer and slides away with it** (it already does structurally; the fix is making the slide actually travel — see §3.1).
- **The edge-tab renders only when FULLY closed**, and we gate it on a settled-closed flag, not the raw `!open` boolean, so it can't co-exist with the drawer mid-transition (see §3.2).
- When closed: **no ✕, no orphan strip** — the chat reflows to full width via the `--preview-w → 0` padding (kept), while the drawer itself is fully off-screen at its real width.

**Preview is ONE tabbed surface.** Already correct: `PreviewPanel` is a single frame with a `Preview ⇄ Code ⇄ Trust` tablist (`PreviewPanel.tsx:92-111`) and a browser-chrome header (traffic-lights + URL pill, `:207-218`). The device toggle lives inside `DeviceFrame` (`:233`). No co-equal panels. We keep this verbatim — it is the strongest part of the current build. We only relocate the **close ✕ into that same header row** alongside the tablist so the header reads as one piece of chrome instead of a lone ✕ on its own border-bottom line.

### 2c. Exact positioning / z-index / overflow rules (the anti-jumble contract)

```
shell  (relative)                       --preview-w cascades to both
 ├─ section (chat)                       lg:[padding-right:var(--preview-w)] when open
 ├─ aside  (drawer)   absolute inset-y-0 right-0
 │     z-20   overflow-hidden            ← NEW overflow-hidden
 │     width = ratio*containerWidth ALWAYS (not 0 when closed)   ← decoupled
 │     transform: open ? translateX(0) : translateX(100%)
 ├─ edge-tab (button) absolute right-0   z-30  {showEdgeTab && …}   ← settled-closed only
 ├─ fab (mobile)      fixed   z-40  lg:hidden
 └─ overlay (mobile)  fixed   z-50  lg:hidden
```

- **z-order:** drawer `z-20` < edge-tab `z-30` < FAB `z-40` < mobile overlay `z-50`. The edge-tab is now strictly above the drawer, so even if both painted for one frame the tab is never *behind* the slid-off drawer; combined with the settled-closed gate it never visually overlaps.
- **`overflow-hidden` on the aside** clips any region-B content during the slide and at narrow widths — kills the bleed.
- **width decoupled from open** (the core fix): the aside is `ratio*containerWidth` whenever `containerWidth` is known; only the chat *padding* gates on `open`. Now `translateX(100%)` carries the full-width drawer (✕ included) genuinely off-screen.

---

## 3. The bug fixes (precise)

### 3.1 Close-✕-when-closed (Issue 1)
**`ChatStudio.tsx:478`** — decouple width from open:
```ts
const previewW = containerWidth ? `${Math.round(clampRatio(ratio, containerWidth) * containerWidth)}px` : '0px'
```
Drive the chat reflow separately — gate **only** the padding on `previewOpen` (already done at `:526`, keep). Add a separate var or reuse: the padding class stays `previewOpen ? 'lg:[padding-right:var(--preview-w)]' : ''`, so when closed the chat goes full width while the aside still has real width to translate off-screen.

**`PreviewDrawer.tsx:201`** — add `overflow-hidden` to the aside className. Now the slid-off drawer (✕, header, region B) is fully off-canvas with nothing painting at the right edge. The ✕ travels *with* the drawer — exactly the "X lives inside and slides away" model.

### 3.2 Right-side jumble + clip (Issue 2)

- **Edge-tab vs drawer overlap** — gate the edge-tab on a *settled-closed* flag, not raw `!open`. In `PreviewDrawer`, derive it from an `onTransitionEnd` on the aside:
```ts
const [settledClosed, setSettledClosed] = useState(!open)
useEffect(() => { if (open) setSettledClosed(false) }, [open])   // opening hides tab immediately
// aside: onTransitionEnd={e => { if (e.propertyName === 'transform' && !open) setSettledClosed(true) }}
```
Render the edge-tab only when `settledClosed`. Opening hides the tab on the first frame (no lag); closing reveals it only after the slide finishes — they can never co-exist. Under `prefers-reduced-motion` the transition is instant, so `transitionend` fires immediately (acceptable; fall back to `!open` when `motion-reduce`).
- **Edge-tab z-index** — `z-40` → `z-30` (above drawer `z-20`, below FAB `z-40`).
- **`<lg` overlay bleed** — `overflow-hidden` on the aside (§3.1) clips region B. The `<lg` overlay-over-chat is by-design (mobile), but it must not bleed past the viewport right edge — `overflow-hidden` guarantees it.
- **"ÇA TEST" clip** — `TestStats.tsx:58`: switch the grid from viewport-`sm:` to a **container query** so columns key off the drawer's real width, not the screen:
```tsx
<div className="@container">
  <div className="grid grid-cols-2 gap-2 @[26rem]:grid-cols-4">
```
Below 26rem of *pane* width it stays 2×2 and the TR label `'Çalışan test'` never clips. (Tailwind's `@container` is available; if the build's Tailwind lacks the container plugin, fall back to forcing `grid-cols-2` inside the drawer and `lg:grid-cols-4` only in the wider mobile-overlay — but container query is the correct fix.)

### 3.3 Chat-not-foreground (Issue 3)
**`ChatStudio.tsx:526`** — raise contrast: `bg-white/[0.02]` → `bg-slate-900/60`, `border-white/10` → `border-white/12`, swap the outward violet glow for the contained inset+drop shadow in §2a. Purely cosmetic; structure untouched. Max-width already handled (`:529`).

### 3.4 Auto-scroll during a build (Issue 4)
**Owner wants follow.** The clean hook (per the grounding) is for the **active `RunBlock` to scroll its own bottom into view on `live.messages` change** — `nodes` is intentionally decoupled from per-frame SSE. In `RunBlock.tsx`, when `active` and the user hasn't scrolled up, scroll the block's tail sentinel into view on `live.messages.length` change:
```ts
// RunBlock: a tail sentinel <div ref={tailRef}/> after the bubbles map
useEffect(() => {
  if (!active) return
  tailRef.current?.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
}, [active, live.messages.length])
```
Crucially this fires on `live.messages.length` (one scroll per *new bubble*, not per token) so it respects the rAF fold and never fights the SSE coalescer. To honor the "don't yank a reader" rule, AkisChat exposes its `stickToBottom` intent down to the active RunBlock (a `follow` boolean prop, true while `atBottom`); the RunBlock only auto-scrolls when `follow` is true. The existing "jump to latest" pill (`AkisChat.tsx:624`) covers the scrolled-up case.

### 3.5 Narrow-width behavior (Issue 2/6 cross-cut)
At `<lg` the FAB + full-screen overlay (`PreviewDrawer.tsx:285-345`) own the preview — keep. The fixes that make this clean: `overflow-hidden` on the desktop aside (no bleed when the breakpoint flips), the container-query TestStats grid (no clip in the narrow overlay), and the settled-closed edge-tab gate (the `hidden lg:flex` tab never shows at `<lg` anyway, but the gate removes the transient).

---

## 4. Live agent activity — "alive," not "Kod yazılıyor…"

The brief's three signals — **animated cue + dynamic text label + live time + one live substatus** — map directly onto the already-folded `AgentMsg` (`chatModel.ts:8`: `tools`, `notes`, `done`, `ok`, `attempts`, `metrics`). The data is *already there*; we render it. **No new SSE events** — we reuse the existing `text`→`notes` fold and the rAF coalescer.

### 4a. The per-agent row (redesigned `AgentBubble`)
```
[●pulse] Proto · Kod yazılıyor                              00:18
         └ src/components/AuthForm.tsx                       ← latest note, single-line
         Kod yazılıyor ✓ · Testler çalışıyor …              ← compact tool chips
         12.4k tok · 1 araç · 42s                            ← settles on agent_end
```

- **Left dot** — keep `dot(ok, done)` (`ChatThread.tsx:38`): `animate-pulse` teal = active, emerald = done, rose = failed. Respect `prefers-reduced-motion` (swap pulse for `motion-reduce:animate-none` + a subtle opacity fade — already partially honored via `motion-safe:` elsewhere).
- **Present-tense phase** — the agent name + a phase derived from the *latest unresolved tool* (`tools[last]`): "Kod yazılıyor" / "Testler çalışıyor" / "Spec yazılıyor". When no tool is open yet, fall back to `chat.working`. This makes the label *change as it works* instead of a frozen "çalışıyor…".
- **LIVE elapsed timer (the gap)** — a new `<LiveElapsed startedAt=… running={!m.done}/>` leaf, mirroring `StartingElapsed` (`ChatStudio.tsx:50-64`) verbatim in spirit: its own `setInterval(1s)`, `tabular-nums`, so a tick re-renders only the badge, never the run tree. Seed `startedAt` from the first `agent_start` of this bubble — add `startedAt` to `AgentMsg` set in `chatModel.ts:58` (`startedAt: Date.now()`) and reset on re-run coalesce (`:55`). When `m.done`, freeze to the static `fmtDuration(m.metrics.durationMs)` (authoritative server time).
- **One live substatus line** — render the **latest** `m.notes` entry (`notes[notes.length-1]`), truncated single-line (`truncate`), 12px muted. This is the "writing src/…" line the brief calls for and the discarded data the grounding flagged. Keep the full English-narration suppression for *outside-turn* `text` (`ChatThread.tsx:64`, `chatModel.ts:80`) — only *in-turn* notes surface, and only the latest one inline (no firehose; Grok anti-pattern avoided).
- **Tool chips** — the existing tool lines (`:84-91`) become a compact wrapped chip row (`flex flex-wrap gap-1`), each `Kod yazılıyor ✓`. Completed = emerald tick, in-flight = pulsing.
- **Tokens/cost** — keep `metricsBadge` (`:95-97`) but promote it to the meta row at consistent size (§5), right of the timer in the collapsed state.

### 4b. Lifecycle: collapse-when-done
On `m.done`, the row collapses to a one-liner mirroring ChatGPT: `✓ Proto · 00:42 · 12.4k tok` (dim, no substatus). Re-runs (`attempts > 1`) keep the `↻N` chip (`:81`). This keeps the panel calm after a long build — the active row is the only "loud" one.

### 4c. Streaming mechanics (unchanged, confirmed safe)
The fold-per-rAF in `useLiveChat.ts:81-84` already coalesces ~100 notes/sec into one render/frame. Rendering `notes[last]` + the tool chips adds zero SSE surface — it reads the same folded `AgentMsg`. The client-side 1s timer is independent of event cadence (per the brief: don't depend on events for the clock).

---

## 5. Typography & spacing system

One scale shared across bubbles, agent rows, headings, and meta. Numbers always `tabular-nums`.

| Token | Use | Tailwind |
|---|---|---|
| **Body** | bubble prose (user/assistant/agent notes) | `text-[14px] leading-relaxed` |
| **Agent name / phase** | the live row label | `text-[13px] font-semibold text-slate-100` |
| **Substatus** | latest note line | `text-[12px] leading-snug text-slate-400 truncate` |
| **Tool chips** | `Kod yazılıyor ✓` | `text-[11px] text-slate-400`, accent slug `text-violet-300` |
| **Meta (timer/cost)** | elapsed + tokens | `text-[11px] tabular-nums text-[#07D1AF]/70` (was `text-[10px]`) |
| **Section eyebrow** | gate label, trust-ledger title | `text-[10px] uppercase tracking-[0.18em] text-slate-500` |
| **Heading** | run title, preview tablist | `text-sm font-semibold text-slate-200` |

- **Rhythm:** bubbles `gap-4`; inside a bubble `space-y-1.5`; row vertical padding `py-3`. Corner radii unified at `rounded-2xl` (bubbles) / `rounded-lg` (chips, cards). The per-role left-accent stripe (`ChatThread.tsx:27-33, 76`) stays — it's the right scannability cue; bump to `border-l-2`.
- **Reading measure:** keep `max-w-[42rem]` agent / `max-w-[46rem]` assistant (`ChatThread.tsx:36`, `AkisChat.tsx:118`) — already correct.
- **Copy button:** add the hover/focus-revealed `CopyButton` (the existing idiom, `AkisChat.tsx:138`) to `DoneBubble` (copy the shipped URL/summary) and to the agent row's substatus when notes exist. Reuses `copy.reply` / a new `copy.agentNotes` key.
- **Elapsed/cost meta:** unify at `text-[11px] tabular-nums`; the live timer and the final `metricsBadge` share this exact class so the digit width never jitters mid-tick and the row doesn't reflow when the live clock freezes into the static duration.

---

## 6. Component / wiring plan (file:line; sacred constraints held)

| File | Change |
|---|---|
| `ChatStudio.tsx:478` | `previewW = containerWidth ? …ratio*containerWidth… : '0px'` (decouple from `previewOpen`). Padding stays gated on `previewOpen` at `:526`. |
| `ChatStudio.tsx:526` | Chat `<section>`: `bg-slate-900/60 border-white/12` + contained inset/drop shadow; `gap-4 py-5` on the inner column (`:529`). |
| `ChatStudio.tsx:50-64` | Generalize `StartingElapsed` → export a `LiveElapsed({ startedAt, running })` leaf reused by the agent row (same interval pattern, `tabular-nums`). |
| `PreviewDrawer.tsx:201` | Add `overflow-hidden`; aside `z-30→z-20`; add `onTransitionEnd` → `settledClosed`. |
| `PreviewDrawer.tsx:236-245` | Move the ✕ into the same header row as the preview chrome (compose with the tablist visually); keep `onClose` calling the bare `onClose` prop (no gate authority). |
| `PreviewDrawer.tsx:259-279` | Edge-tab: gate on `settledClosed` (with `motion-reduce` fallback to `!open`); `z-40→z-30`. |
| `chatModel.ts:8` | Add `startedAt: number` to `AgentMsg`. Set at `:58` (`startedAt: Date.now()`), reset on coalesce at `:55`. ADDITIVE — old folds unaffected. |
| `ChatThread.tsx:68-101` | Rebuild `AgentBubble`: present-tense phase from latest open tool, `<LiveElapsed>` while `!done` (freeze to `fmtDuration` on done), one truncated `notes[last]` substatus, chip-row tools, unified type scale (§5), collapse-when-done, optional `CopyButton`. Avatar/accent/`↻N`/gate handlers untouched. |
| `TestStats.tsx:58` | `@container` wrapper + `grid-cols-2 @[26rem]:grid-cols-4` (drawer-width responsive). |
| `RunBlock.tsx` | Add a tail sentinel + active-only `scrollIntoView` on `live.messages.length` when `follow` (new prop from AkisChat). Memo bail preserved (boolean prop). |
| `AkisChat.tsx:530-545` | Pass `follow={atBottom}` to the active `RunBlock`. |
| `catalog.ts` (EN+TR) | New keys if used: `copy.agentNotes`, any phase strings already exist (`chat.tool.*`). Both locales, strict-TS spread idiom (`{...(x !== undefined ? {x} : {})}`) where optional. |

**Sacred-constraint audit:** Gates — `GateBubble`/`RecoveryBubble` still call bare `onApprove`/`onConfirm`/recovery callbacks; no client mint added. Iframe — `PreviewPanel.tsx:236-238` sandbox tag untouched. SSE — no new events; `notes[last]` + chips read the existing rAF fold (`useLiveChat.ts:81-84`); the 1s timer is client-local. Remount — the drawer stays an `absolute` sibling of the chat `<section>` (`ChatStudio.tsx:540`); `AkisChat key={threadKey}` slot (`:434/532`) unchanged; no wrapper introduced.

---

## 7. Test + VISUAL-verify plan

**Unit/RTL (vitest):**
- `previewW` ≠ `'0px'` while a container is measured and the drawer is closed; chat padding-right is 0 when closed. Assert the aside carries `overflow-hidden`.
- Edge-tab not rendered while `open`; rendered only after the aside's `transitionend` (simulate). Both never in the DOM simultaneously.
- TestStats: render at a 24rem container → 2 columns, "Çalışan test" not truncated; at 30rem → 4 columns.
- `AgentBubble`: given an `AgentMsg` with `notes` + `!done`, the latest note renders single-line and a timer node exists; on `done` the timer equals `fmtDuration(metrics.durationMs)`.
- Memo: a parent re-render with a terminal RunBlock does not re-render it (boolean `follow` only flips the active one).

**Browser VISUAL-verify (Brave automation profile, per machine rules):**
1. **Desktop (1440px), drawer states:** closed → assert NO ✕ anywhere on the right, NO orphan strip, chat full-width; click edge-tab → drawer slides in, ✕ inside header, edge-tab gone; click ✕ → drawer slides fully off, edge-tab reappears only after the slide. Screenshot all three + capture *mid-transition* (≈150ms) to prove no tab+drawer overlap.
2. **Narrow (1024 and 768px):** confirm `<lg` FAB+overlay path; no region-B bleed past the right edge; TestStats 2×2, label intact.
3. **Resize drag:** drag the separator across the full range — at the narrowest pane, TestStats stays 2×2 and never clips; no jumble.
4. **Live build:** start a real build (dev.sh, REAL by default). Watch the active agent row: the phase label *changes* (Spec→Code→Tests), the substatus line *streams* (file paths), the timer *ticks* every second, then *freezes* to the server duration on done; the row *collapses* to a one-liner. Confirm the view *follows* new bubbles while at bottom and does *not* yank when scrolled up (pill appears).
5. **Foreground contrast:** screenshot the chat against the page — the section is visibly elevated; against an open preview the chat/app boundary is unambiguous.
6. `prefers-reduced-motion`: re-run #1 and #4 with the flag — slides snap, pulse becomes fade, timer still ticks.

---

## 8. Risks / open questions

- **`transitionend` reliability:** if the transform transition is interrupted (rapid open/close), `transitionend` may not fire and `settledClosed` could stick. Mitigation: also set `settledClosed` via a `setTimeout(310ms)` fallback armed on close, and clear both on open. Under `motion-reduce`, gate the tab on `!open` directly.
- **Container queries:** confirm the project's Tailwind has `@container` (v3.3+ / container plugin). If not, the documented fallback (force `grid-cols-2` in the drawer, `grid-cols-4` only in the wider overlay) ships instead — slightly less elegant but clip-free.
- **`startedAt` on reopened/terminal runs:** a replayed `/log` fold has no real wall-clock start for the live timer; for terminal blocks we must *not* tick — render the static `fmtDuration` only (the timer leaf is mounted with `running={false}`). Guard: `LiveElapsed` ticks only when `running && !terminal`.
- **Active-RunBlock auto-scroll vs. the header-to-top scroll (`AkisChat.tsx:289`):** the run-start scroll pins the header to top; the new tail-follow must not fight it on the first frame. Sequencing: tail-follow keys on `live.messages.length` (first bubbles arrive *after* the header scroll settles), so they don't collide — verify in #4.
- **Owner decision:** should the collapsed done-row be click-to-expand (re-show notes/steps)? Recommended yes (progressive disclosure), but it adds per-row local state — flag for owner sign-off before building.

---

**Files referenced (absolute):** `/Users/omeryasironal/Projects/akis-platform-mvp/frontend/src/chat/ChatStudio.tsx`, `/frontend/src/components/PreviewDrawer.tsx`, `/frontend/src/chat/ChatThread.tsx`, `/frontend/src/chat/chatModel.ts`, `/frontend/src/chat/AkisChat.tsx`, `/frontend/src/chat/RunBlock.tsx`, `/frontend/src/chat/RunPipeline.tsx`, `/frontend/src/chat/useLiveChat.ts`, `/frontend/src/chat/metricsFormat.ts`, `/frontend/src/chat/useResizable.ts`, `/frontend/src/components/PreviewPanel.tsx`, `/frontend/src/components/TestStats.tsx`, `/frontend/src/i18n/catalog.ts`.

---

## Review — Feasibility (akis-reviewer)

This confirms the decisive finding for section 4. Proto uses `chatWithContinuation` (NON-streaming) — there is NO token-streaming of Proto/Scribe prose. Proto emits `agent_start`, `tool_call`, then awaits the full non-streamed reply, then `tool_result` + `agent_end`. No `text` event is ever emitted by a subagent. The only `text` events come from `Orchestrator.narrate`, all `agent: 'orchestrator', laneId: 'main'`, and they fire BEFORE or AFTER (not during) a subagent's `'main'`-lane turn, because the orchestrator `await`s the subagent run start-to-finish.

I have everything needed. Let me write the review.

---

ADVERSARIAL REVIEW — AKIS Studio chat+preview redesign

Verdict: bug-fixes (issues 1–3) are SOUND and correctly target the screenshots. The auto-scroll plan (issue 4) is feasible with one real caveat. The live-agent-message plan (section 4) is **built on a false premise about the existing SSE data** and will ship fake/empty UI as written — this is the one HIGH finding.

---

HIGH — Live "streaming substatus" (`notes[last]`) has no real per-agent data to render; the premise is wrong
File: design §4a / §5 vs `backend/src/orchestrator/Orchestrator.ts:70-71`, `backend/src/orchestrator/subagents/ProtoAgent.ts:129-182`, `backend/src/orchestrator/subagents/ScribeAgent.ts:152-199`, `frontend/src/chat/chatModel.ts:77-82`

The design's "the real streamed prose is captured and discarded" / render `notes[notes.length-1]` as a live "writing src/AuthForm.tsx" substatus rests on `text` events folding into the open agent turn's `m.notes`. Evidence against:
- The ONLY emitter of `kind:'text'` in the entire backend is `Orchestrator.narrate` (Orchestrator.ts:71), always `agent:'orchestrator', laneId:'main'`, and always English prose ("Iterating (attempt 2)…", "Planning: …"). No subagent emits `text` at all (grep: zero hits in `subagents/`).
- Proto/Scribe run with `laneId:'main'` (Orchestrator.ts:205, 327) and produce code via `chatWithContinuation` — a NON-streaming call (ProtoAgent.ts:163). They emit only `agent_start` / `tool_call` / `tool_result` / `agent_end`. There is no token stream and no per-file narration.
- Because the orchestrator `await`s each subagent run start-to-finish, every `narrate()` fires when the `'main'` turn is CLOSED → in the fold it lands in the `else` branch (chatModel.ts:80) as a `narration` item, which is deliberately suppressed (`NarrationBubble → null`). It does NOT populate `m.notes`.

Consequence: `notes[last]` will be empty for essentially every real build, so the "live substatus line" renders nothing — OR, in the rare ordering where a narrate did fold into an open turn, it would surface raw English orchestrator prose in the TR UI (an i18n regression and a re-leak of the very narration §2 says stays suppressed). The mock-up "└ src/components/AuthForm.tsx" is fabricated data that the pipeline never produces.

Fix: drop the `notes[last]` substatus from the design, OR make it real first with a backend change (out of the stated FRONTEND-only scope): have Proto/Scribe emit their own `kind:'text'` ephemeral events on their OWN laneId with localizable/structured payloads (e.g. a `phase` enum, not free English), and assign subagents a distinct laneId so their turn is open when those events arrive. Until then, the honest live signals are the ones that DO exist: the pulsing dot, the present-tense phase from the latest open `tool` (real — tool_call/tool_result fold correctly, chatModel.ts:71-74), and the live elapsed timer.

---

MED — `startedAt` for the live timer cannot use `Date.now()` at fold time without drifting on reopen/replay
File: design §4a (`startedAt: Date.now()` set in `chatModel.ts:58`) and §8 open-question

`foldRunBubbles` runs over the WHOLE event log on every rAF (useLiveChat.ts:72, 83) and is documented as "Pure + deterministic" (chatModel.ts:26). Setting `startedAt: Date.now()` inside the fold violates purity and, worse, re-seeds to "now" on every refold for the active run (the bubble object is rebuilt each fold — fold creates fresh `AgentMsg` objects per call, it does not persist them across folds), so the elapsed timer would reset toward 0 on each frame instead of counting up. The design's own §8 flags the terminal/replay case but misses the active-run refold case.

Fix: derive `startedAt` from the agent_start event's own timestamp (`e.ts` — events carry `ts`), not `Date.now()`. That is deterministic across refolds and correct for both live and replayed logs. Then `LiveElapsed` ticks only when `running && !terminal` (as §8 already says). Confirm `e.ts` is wall-clock ms and not the seq counter before relying on it (Orchestrator uses `nextTs()` — verify its unit; if it is a logical counter, you need a real `Date.now()` captured once at append, which means the studio/AkisChat layer, not the pure fold).

---

LOW — `previewW` decouple (issue 1 fix) is correct, but verify the drag path still writes a real width when closed
File: `frontend/src/chat/ChatStudio.tsx:470,478`; `frontend/src/components/PreviewDrawer.tsx:197-201`

The core fix is sound: today `previewW` is `'0px'` when closed (ChatStudio.tsx:478), the aside is `width: var(--preview-w)` with NO `overflow-hidden` (PreviewDrawer.tsx:198,201), so `translateX(100%)` of a 0-px box travels 0px and the ✕ header (PreviewDrawer.tsx:236) paints at the right edge — diagnosis confirmed. Decoupling width from `open` + adding `overflow-hidden` genuinely makes the ✕ slide off. Two notes:
- The chat padding gate already lives at ChatStudio.tsx:526 (`previewOpen ? 'lg:[padding-right:var(--preview-w)]' : ''`), so reflow-to-full-width when closed already works once width is decoupled — the design's claim holds.
- `overflow-hidden` on the aside is safe for the drawer body, but double-check it does not clip the left-edge resize separator, which is `absolute inset-y-0 left-0 -translate-x-1/2` (PreviewDrawer.tsx:224) — it sits half-outside the aside's left edge and WILL be clipped by `overflow-hidden`, making the 12px grab strip a 6px strip. Minor, but the design doesn't mention it. Prefer clipping only the right via the slide rather than blanket `overflow-hidden`, or move the separator inside.

---

LOW — Edge-tab z-index claim is backwards in the current code; the settled-closed gate is the real fix
File: `frontend/src/components/PreviewDrawer.tsx:201` (aside `z-30`) vs `:269` (edge-tab `z-40`)

The design says edge-tab `z-40` → `z-30` and aside `z-30` → `z-20`. Confirmed current values match (aside z-30 at :201, edge-tab z-40 at :269). The change is harmless but cosmetic: the edge-tab is already ABOVE the aside today (z-40 > z-30), so re-numbering doesn't fix overlap. The actual anti-overlap mechanism is the `settledClosed`/`onTransitionEnd` gate (§3.2) replacing `{!open}` at :259 — that is the real fix and it is sound, with the §8 `transitionend`-interrupt risk correctly flagged (add the `setTimeout(310)` fallback, and the `motion-reduce → !open` fallback, both noted). Verify the `motion-reduce` path: the aside transition is `motion-safe:transition-transform` (:201), so under reduced motion there is NO transition and `transitionend` NEVER fires — the design's "fall back to `!open` when motion-reduce" is mandatory, not optional, or the tab disappears forever on a reduced-motion machine.

---

LOW — `@container` TestStats fix is feasible (Tailwind v4) but the container ancestor must be established at the right node
File: `frontend/src/components/TestStats.tsx:58`; renders at `PreviewPanel.tsx:332`

Diagnosis confirmed: grid is `grid-cols-2 sm:grid-cols-4` (TestStats.tsx:58), `sm:` keys off viewport, and TR `tests.run` = 'Çalışan test' (catalog.ts:1080) is the "ÇA TEST" clip. Tailwind is v4 (`tailwindcss ^4.3.0`), where `@container`/`@[26rem]:` are CORE (no plugin) — so the §8 "if Tailwind lacks the container plugin" hedge is unnecessary; it will work. Caveat: the `@container` wrapper must go on an element whose width tracks the DRAWER pane, and TestStats is several nested flex levels below the drawer (PreviewPanel → band → TestStats). Putting `@container` directly on TestStats' own root is correct since that root spans the pane width. Confirm the threshold: at the 30rem floor the four cells `border + px-3 + text-lg` value must actually fit — `@[26rem]:grid-cols-4` is a reasonable guess but should be tuned against the longest TR label, not assumed.

---

SOUND — Chat-foreground (issue 3) and auto-scroll (issue 4)
- §3.3: chat `<section>` is `bg-white/[0.02]` + outward violet glow (ChatStudio.tsx:526) — confirmed near-invisible; raising to `bg-slate-900/60` + inset shadow is a real, structure-neutral contrast fix. The inner column at :529 indeed adds no surface. Sound.
- §3.4 auto-scroll: diagnosis is correct — `appendRun` sets `stickToBottom.current=false` (AkisChat.tsx:331) and the `[nodes, busy]` effect (AkisChat.tsx:276-283) never re-fires on live SSE because RunBlock's `useLiveChat` state is not in `nodes`. The proposed per-RunBlock tail `scrollIntoView` keyed on `live.messages.length` (one scroll per new bubble, respecting the rAF fold) is feasible and won't fight the coalescer. Two real cautions the design partially covers: (a) passing a `follow` boolean keeps `RunBlock`'s `React.memo` intact (booleans, RunBlock.tsx:173) — good; (b) the new tail-follow must not race the run-header-to-top `useLayoutEffect` (AkisChat.tsx:289-301) on the first frame — §8 flags this and the `live.messages.length` keying makes it safe in practice, but it MUST be VISUAL-verified on a real build (the design's test plan #4 covers it).

---

Net: ship the layout/contrast/scroll fixes (issues 1–4) — they correctly address the screenshots. Cut or re-scope the "live streaming substatus" (§4a `notes[last]`): it is the only part that promises data the backend does not produce, and as written it renders either nothing or suppressed English. Keep the live timer but seed it from `agent_start.ts`, not `Date.now()` in the fold.

---

## Review — Gate-safety (akis-gate-keeper)

I now have complete grounding on every file the design touches. Let me verify the design's claims against the actual code for each sacred constraint.

**1. Gates render in chat, not moved/weakened.** Confirmed. `GateBubble`/`RecoveryBubble` (ChatThread.tsx:107-165) call bare `onApprove`/`onConfirm`/recovery callbacks; the design's component table only touches `AgentBubble` (ChatThread.tsx:68-101) and explicitly states "Avatar/accent/↻N/gate handlers untouched." The gate bubbles are not in the change list. The drawer's `cards` slot carries Trust/Publish/Proposals, not gates — gates stay inline in the chat thread. PASS.

**2. iframe sandbox + /preview/ allowlist untouched.** Confirmed. The sandbox tag lives at PreviewPanel.tsx:236-238 (`sandbox="allow-scripts allow-forms allow-popups"`, no `allow-same-origin`) and the `embeddable = !!url && url.startsWith('/preview/')` allowlist at :80. The design's component table does NOT list PreviewPanel.tsx among changed files, and §6's sacred-constraint audit explicitly states "Iframe — PreviewPanel.tsx:236-238 sandbox tag untouched." The drawer renders PreviewPanel as an opaque `preview` slot. PASS.

**3. SSE/fold semantics — reuse existing fold, no new authority/event path.** This is the key risk area. Verified:
- The live-agent improvement renders `m.notes` (already folded at chatModel.ts:77-82) — the data exists and is currently discarded by `AgentBubble`. Rendering `notes[last]` adds zero SSE surface.
- The `startedAt` addition (chatModel.ts:8/55/58) is a pure client-clock seed inside the existing fold — additive, not a new event. No new `AkisEvent` kind, no new SSE frame.
- The `LiveElapsed` timer is a client-local `setInterval` mirroring the existing `StartingElapsed` (ChatStudio.tsx:50-64) — independent of event cadence. PASS.
- The auto-scroll keys on `live.messages.length` (one scroll per bubble), reusing the existing rAF-coalesced fold (useLiveChat.ts:81-84). It does NOT add a setState or a second SSE subscription. PASS.

**4. key={threadKey} not remounted.** Confirmed. The design keeps the drawer as an absolute sibling of the chat `<section>` (ChatStudio.tsx:540, outside the `<section>`), never a wrapper, and lists no change to ChatStudio.tsx:435 (`key={threadKey}`) or the tree position. PASS.

**5. No FE gate minting.** Confirmed. All callbacks remain bare POSTs (client.ts:223-238). The design adds `follow={atBottom}` (a boolean) and an `onClose` relocation that "keeps onClose calling the bare onClose prop (no gate authority)." No token construction anywhere. PASS.

Now I'll flag the few places where the design's described wiring is slightly inaccurate vs. the real code — these are correctness notes for the implementer, not gate risks.

GATE-SAFE — no sacred-constraint violations. The redesign is FE cosmetic/layout plus a render-only surfacing of already-folded data; every sacred invariant holds against the real code.

Verified, file by file:

- **Gates in chat, not moved/weakened** — PASS. `GateBubble`/`RecoveryBubble` (`/Users/omeryasironal/Projects/akis-platform-mvp/frontend/src/chat/ChatThread.tsx:107-165`) keep their bare `onApprove`/`onConfirm`/recovery callbacks; the design's change list touches only `AgentBubble` (`:68-101`) and explicitly says "gate handlers untouched." Gates stay inline in the thread; the drawer's `cards` slot holds Trust/Publish/Proposals only (`ChatStudio.tsx:481-498`), never a gate.
- **iframe sandbox + /preview/ allowlist** — PASS. `sandbox="allow-scripts allow-forms allow-popups"` (no `allow-same-origin`) at `PreviewPanel.tsx:238` and `embeddable = …url.startsWith('/preview/')` at `:80` are NOT in the design's changed-files table; §6 audits them as untouched. The drawer renders PreviewPanel as an opaque slot.
- **SSE/fold — reuse, no new authority/event** — PASS. `notes[last]` is already folded at `chatModel.ts:77-82` (currently discarded by `AgentBubble`); the new `startedAt` (`chatModel.ts:8/55/58`) is an additive client-clock field inside the existing fold — no new `AkisEvent` kind, no new SSE frame. `LiveElapsed` is a client-local `setInterval` (mirrors `StartingElapsed`, `ChatStudio.tsx:50-64`), event-independent. Auto-scroll keys on `live.messages.length` (one scroll/bubble), reusing the rAF coalescer at `useLiveChat.ts:81-84` — no new subscription, no extra setState on the SSE path.
- **key={threadKey} not remounted** — PASS. Drawer stays an absolute sibling OUTSIDE the chat `<section>` (`ChatStudio.tsx:540`, after `:534`); `AkisChat key={threadKey}` (`:435`) and the tree slot are not in the change list. No wrapper introduced.
- **No FE gate minting** — PASS. All actions remain bare POSTs to gated routes (`client.ts:223-238`); the only new prop is a boolean `follow`, and the relocated ✕ keeps calling the bare `onClose`. No token construction.

Two non-blocking accuracy notes for the implementer (correctness, not gate risk):

1. `previewW` (`ChatStudio.tsx:478`) is the SOLE writer of `--preview-w`, which the aside reads as `width: var(--preview-w)` (`PreviewDrawer.tsx:198`). The design's §3.1 fix decouples width from `previewOpen` so the closed drawer keeps real width to translate off-screen — but it must keep the chat reflow gated on `previewOpen` at `:526` (it says so). Note the live-drag path also writes `--preview-w` directly on the shell during a drag (`ChatStudio.tsx:467-471`); the implementer must ensure the new closed-state width doesn't fight the drag handler (drag only runs while open, so this is fine, but worth a test).

2. The design's §3.4 says `AkisChat.tsx:530-545` should "pass `follow={atBottom}` to the active RunBlock" — `atBottom` exists (`AkisChat.tsx:218`) and the RunBlock call site is exactly `:530-545`, so the wiring is faithful. But the authoritative scroll-intent is `stickToBottom.current` (a ref, `:223`), not the `atBottom` state; the design correctly chose `atBottom` (the rendered state) for the prop. Just confirm the active-RunBlock tail-scroll respects the existing run-header-to-top scroll (`AkisChat.tsx:289-301`) — the design flags this in §8 as a sequencing risk to verify, which is the right call.

One thing the design slightly mis-cites but harmlessly: it says `AgentBubble never renders m.notes` (true) and proposes surfacing `notes[last]`. The suppression of *out-of-turn* narration (`chatModel.ts:80` → `NarrationBubble` returns null, `ChatThread.tsx:64`) stays intact since `notes` are only in-turn folds — the design preserves that boundary correctly.

No HIGH/MED/LOW gate findings. Safe to build.