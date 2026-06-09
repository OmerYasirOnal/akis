# Studio Cohesion Redesign — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the AKIS studio one integrated, modern surface and fix the three confirmed bugs (scrollbar/seam, conversation-lost-on-return, Scribe stuck "beklemede"), with a live/correct agent roster and first-class mobile.

**Architecture:** Frontend-heavy (React+Vite+strict-TS+Tailwind). Two backend touches are observational/additive and gate-safe: a synthetic Scribe `agent_start/end` on the seeded path, and seeding `session.chat` at build start. The conversation is de-carded; only the composer, preview pane, and structured artifact blocks are bordered. Shared scrollbar/radius/border tokens.

**Tech Stack:** React 18, Vite, TypeScript (strict, exactOptional), Tailwind, Vitest + Testing Library; backend Fastify + tsx, existing test harness; SSE event bus + foldSessionView; i18n catalog (TR+EN).

**Reference spec:** `docs/superpowers/specs/2026-06-09-studio-cohesion-redesign-design.md`
**Visual reference:** `.superpowers/brainstorm/85755-1780993316/content/studio-v3.html`

**Sacred constraints (NEVER violate):**
- Do NOT change the 4 structural gates, their server-side minting, capability tokens, or owner-scoping. Backend changes here only emit bus events or write the non-gate `chat` column.
- Every new/changed user-facing string lands in BOTH `tr` and `en` in `frontend/src/i18n/catalog.ts`.
- Strict TS: no `any`; honor exactOptionalPropertyTypes.
- Run `akis-gate-keeper` on every backend diff (Tasks 1, 3) before merge; `akis-reviewer` on every task before merge.

---

## File Structure (what changes and why)

**Backend (gate-safe, additive):**
- `backend/src/orchestrator/Orchestrator.ts` — seeded branch (~177-190): emit synthetic Scribe `agent_start`+`agent_end` before `kickRun()`.
- `backend/src/api/sessions.routes.ts` + `backend/src/api/server.ts` — accept an optional pre-build `chat` on startSession and seed `session.chat` (bounded by `CHAT_TURNS_MAX`).

**Frontend — bug logic:**
- `frontend/src/chat/akisThread.ts` — add `mergeSpine()` (pure, tested).
- `frontend/src/chat/ChatStudio.tsx` — `seedRun` merges instead of overwrites; pass pre-build chat to `startSession`.
- `frontend/src/components/AgentRoster.tsx` — `presenceOf` Scribe fallback on satisfied spec gate; active-agent highlight + caption + progress.

**Frontend — cohesion/UI:**
- `frontend/src/index.css` — scrollbar tokens (`.akis-scroll`), radius/border tokens.
- `frontend/src/chat/AkisTranscript.tsx` — flatten assistant turns (plain), tint only user turns, cap measure.
- `frontend/src/chat/AkisChat.tsx` — composer becomes one rounded shell; scroll container gets `.akis-scroll` + gutter.
- `frontend/src/chat/ModelPicker.tsx` — full-screen modal → anchored popover.
- `frontend/src/chat/ModelChip.tsx` — drop the live/demo badge.
- `frontend/src/chat/ChatStudio.tsx` — drop the elevated `<section>` card; seam gap; sticky build-status bar; tokens.
- `frontend/src/chat/HistoryMenu.tsx` — anchor "+ Yeni sohbet" at the top, always available.
- `frontend/src/components/PreviewDrawer.tsx` — mobile bottom-sheet snap points (peek/half/full); seam/gap on desktop.

**i18n:** `frontend/src/i18n/catalog.ts` — new keys for captions/status/popover.

---

## Task 1: Bug C — Scribe status correct (backend synthetic event + FE fallback)

**Files:**
- Modify: `backend/src/orchestrator/Orchestrator.ts:177-190` (seeded branch)
- Test: `backend/src/orchestrator/Orchestrator.test.ts` (or the existing orchestrator test file)
- Modify: `frontend/src/components/AgentRoster.tsx:22-35` (`presenceOf`)
- Test: `frontend/src/components/AgentRoster.test.tsx`

- [ ] **Step 1: Read the current seeded branch.** Open `backend/src/orchestrator/Orchestrator.ts` around `start()` (lines ~170-210). Confirm: when `input.spec` is present it persists the spec, narrates, calls `mintSpecApproval(...)`, `kickRun()`, and returns WITHOUT `this.s.scribe.run()`. Note the exact `bus.emit` shape used elsewhere (the `agent_start`/`agent_end` payload: `{ kind, agent, ... }`) by reading `ScribeAgent.ts:158/164/199`.

- [ ] **Step 2: Write the failing backend test.** In the orchestrator test, drive a seeded-spec start and assert the event stream now contains a scribe `agent_start` AND `agent_end`, and that the spec gate is still minted exactly once (unchanged).

```ts
it('seeded-spec start records a Scribe agent_start/agent_end (so the roster shows Scribe done)', async () => {
  const events: AgentEvent[] = []
  const bus = makeTestBus(e => events.push(e))           // mirror the existing test bus helper
  const orch = makeOrchestrator({ bus /* + existing deps */ })
  const { id } = await orch.start({ idea: 'note app', spec: { title: 'Notes', body: '# Notes' } })
  const scribeStarts = events.filter(e => e.kind === 'agent_start' && e.agent === 'scribe')
  const scribeEnds   = events.filter(e => e.kind === 'agent_end'   && e.agent === 'scribe')
  expect(scribeStarts).toHaveLength(1)
  expect(scribeEnds).toHaveLength(1)
  const gateMints = events.filter(e => e.kind === 'gate' && e.gate === 'spec_approval' && e.state === 'satisfied')
  expect(gateMints).toHaveLength(1)                      // gate behavior UNCHANGED
})
```

- [ ] **Step 3: Run it, verify it fails.** Run: `cd backend && npx vitest run src/orchestrator/Orchestrator.test.ts -t 'Scribe agent_start'` — Expected: FAIL (0 scribe starts).

- [ ] **Step 4: Emit the synthetic pair in the seeded branch.** In `Orchestrator.ts`, in the seeded branch, BEFORE `kickRun()` (after the spec is persisted), emit a scribe `agent_start` immediately followed by `agent_end` (ok:true). Use the SAME payload shape as `ScribeAgent.run()`. Example (adapt field names to the real `AgentEvent`/bus API):

```ts
// SEEDED-SPEC PATH: the spec was authored via chat, so ScribeAgent.run() is skipped.
// Record Scribe's stage as DONE so the live roster + /log replay + history agree.
// GATE-SAFE: emits bus events ONLY — mints no gate, no capability token.
this.bus.emit({ kind: 'agent_start', agent: 'scribe', sessionId: id })
this.bus.emit({ kind: 'agent_end',   agent: 'scribe', sessionId: id, ok: true })
```

- [ ] **Step 5: Run backend test, verify PASS.** Run: `cd backend && npx vitest run src/orchestrator/Orchestrator.test.ts -t 'Scribe agent_start'` — Expected: PASS. Then run the full orchestrator test file to confirm no regression: `npx vitest run src/orchestrator/Orchestrator.test.ts`.

- [ ] **Step 6: Write the failing FE fallback test.** In `AgentRoster.test.tsx`, assert that with NO scribe step but a satisfied spec gate, `presenceOf(view,'scribe')` returns `'done'`.

```tsx
it('presenceOf: scribe shows done when the spec gate is satisfied even without a scribe step', () => {
  const view = { ...emptyView('s1'), lanes: [], gates: { specApproval: { gate: 'spec_approval', state: 'satisfied' } } } as SessionView
  expect(presenceOf(view, 'scribe')).toBe('done')
})
it('presenceOf: scribe stays idle when nothing has happened', () => {
  expect(presenceOf({ ...emptyView('s1'), lanes: [] } as SessionView, 'scribe')).toBe('idle')
})
```

- [ ] **Step 7: Run it, verify it fails.** Run: `cd frontend && npx vitest run src/components/AgentRoster.test.tsx -t 'spec gate is satisfied'` — Expected: FAIL (returns 'idle').

- [ ] **Step 8: Add the fallback in `presenceOf`.** In `AgentRoster.tsx`, after the lane-step scan and before the final `return 'idle'`, add a scribe-specific fallback keyed on the folded spec gate (confirmed available at `viewModel.ts:81-83` as `view.gates.specApproval`):

```ts
// Scribe authored the spec via the chat/seeded path, which emits no scribe lane step.
// A satisfied spec gate proves Scribe's stage completed → show 'done' (mirrors orchestrator's fallback).
if (role === 'scribe' && view.gates?.specApproval?.state === 'satisfied') return 'done'
```

- [ ] **Step 9: Run FE test, verify PASS.** Run: `cd frontend && npx vitest run src/components/AgentRoster.test.tsx` — Expected: PASS (both new tests + existing).

- [ ] **Step 10: Gate review + commit.** Dispatch `akis-gate-keeper` on the `Orchestrator.ts` diff (assert no gate/mint change). Then:

```bash
git add backend/src/orchestrator/Orchestrator.ts backend/src/orchestrator/Orchestrator.test.ts frontend/src/components/AgentRoster.tsx frontend/src/components/AgentRoster.test.tsx
git commit -m "fix(studio): Scribe shows done on chat-seeded builds (synthetic agent event + roster fallback)"
```

---

## Task 2: Bug B — `mergeSpine()` pure helper (FE persistence merge)

**Files:**
- Modify: `frontend/src/chat/akisThread.ts` (add `mergeSpine`)
- Test: `frontend/src/chat/akisThread.test.ts`

- [ ] **Step 1: Write failing tests for `mergeSpine`.** Semantics: given the existing local spine and the server's `session.chat` (turns only) for a reopened session id, produce the spine to render. Rule: if the local spine ALREADY contains the run marker for `id`, keep the local spine (richest — has pre-build turns); otherwise build `[greeting, runMarker, ...serverTurns]` (today's behavior, used for cross-device/cleared-storage). Always dedupe adjacent identical `(role,content)`.

```ts
import { mergeSpine, type ThreadNode } from './akisThread.js'

const greet = (): ThreadNode => ({ role: 'assistant', content: 'GREETING' })
const run = (id: string): ThreadNode => ({ role: 'run', sessionId: id, idea: 'note app' })

it('keeps the richer LOCAL spine when it already has the run marker (pre-build turns survive)', () => {
  const local: ThreadNode[] = [greet(), { role: 'user', content: 'a note app' }, { role: 'assistant', content: 'sure' }, run('s1')]
  const serverTurns = [{ role: 'assistant' as const, content: 'sure' }]  // server lacks the pre-build user turn
  const out = mergeSpine({ local, serverTurns, id: 's1', greeting: 'GREETING', idea: 'note app' })
  expect(out).toEqual(local)                                   // pre-build 'a note app' is NOT lost
})

it('falls back to greeting+runMarker+serverTurns when local has no marker for the id (cleared storage)', () => {
  const out = mergeSpine({ local: [], serverTurns: [{ role: 'user' as const, content: 'hi' }], id: 's1', greeting: 'GREETING', idea: 'note app' })
  expect(out).toEqual([greet(), run('s1'), { role: 'user', content: 'hi' }])
})

it('dedupes adjacent identical turns', () => {
  const out = mergeSpine({ local: [], serverTurns: [{ role: 'user' as const, content: 'hi' }, { role: 'user' as const, content: 'hi' }], id: 's1', greeting: 'GREETING', idea: 'x' })
  expect(out.filter(n => 'content' in n && n.content === 'hi')).toHaveLength(1)
})
```

- [ ] **Step 2: Run, verify fail.** Run: `cd frontend && npx vitest run src/chat/akisThread.test.ts -t mergeSpine` — Expected: FAIL (`mergeSpine` not exported).

- [ ] **Step 3: Implement `mergeSpine`.** Add to `akisThread.ts`:

```ts
/** Reconcile the persisted local spine with the server's session.chat on a reopen.
 *  If the local spine already anchors this run (has its run marker), it is the richest copy
 *  (it includes the pre-build, sessionId-less turns the server can never hold) → keep it.
 *  Otherwise (cleared storage / another device) rebuild from the server turns. Adjacent
 *  identical (role,content) pairs are de-duplicated. Pure + storage-free. */
export function mergeSpine(args: {
  local: readonly ThreadNode[]
  serverTurns: readonly { role: 'user' | 'assistant'; content: string }[]
  id: string
  greeting: string
  idea: string
}): ThreadNode[] {
  const { local, serverTurns, id, greeting, idea } = args
  const hasMarker = local.some(n => isRun(n) && n.sessionId === id)
  const base: ThreadNode[] = hasMarker
    ? [...local]
    : [{ role: 'assistant', content: greeting },
       { role: 'run', sessionId: id, idea: idea.trim() },
       ...serverTurns.filter(t => t.content.trim().length > 0).map(t => ({ role: t.role, content: t.content }))]
  return base.filter((n, i) => {
    const p = base[i - 1]
    if (!p || isRun(n) || isRun(p)) return true
    return !(n.role === p.role && n.content === p.content)
  })
}
```

- [ ] **Step 4: Run, verify PASS.** Run: `cd frontend && npx vitest run src/chat/akisThread.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add frontend/src/chat/akisThread.ts frontend/src/chat/akisThread.test.ts
git commit -m "feat(studio): add mergeSpine() to reconcile local spine with server chat on reopen"
```

---

## Task 3: Bug B — wire `mergeSpine` into reopen + seed `session.chat` at build start

**Files:**
- Modify: `frontend/src/chat/ChatStudio.tsx` (`seedRun` ~165-197; `startBuild` ~253-293)
- Modify: `frontend/src/api/client.ts` (`startSession` signature — add optional pre-build chat) — read it first to match the existing signature
- Modify: `backend/src/api/sessions.routes.ts` (startSession route) + `backend/src/api/server.ts` (seed `chat`)
- Test: `frontend/src/chat/ChatStudio.test.tsx`; backend sessions route test

- [ ] **Step 1: Read** `ChatStudio.tsx:165-197` (`seedRun`), `:253-293` (`startBuild`), `api/client.ts` `startSession`, and the backend `sessions.routes.ts` startSession handler (note where `spec`/`base` are forwarded to `orch.start`).

- [ ] **Step 2: FE test — reopen keeps local pre-build turns.** In `ChatStudio.test.tsx`, seed localStorage with a spine containing pre-build user turns + the run marker for `s1`, mock `getSession` to return a thinner `chat`, mount with `?s=s1`, and assert the pre-build user turn is still rendered.

```tsx
it('reopening a build via ?s= does NOT drop pre-build conversation', async () => {
  saveThread([{ role: 'assistant', content: 'GREETING' }, { role: 'user', content: 'a note app please' }, { role: 'run', sessionId: 's1', idea: 'note app' }])
  const api = makeFakeApi({ getSession: async () => ({ id: 's1', idea: 'note app', chat: [{ role: 'assistant', content: 'on it', at: '' }] }) })
  window.history.replaceState({}, '', '/?s=s1')
  render(<ChatStudio api={api} />)
  expect(await screen.findByText('a note app please')).toBeInTheDocument()  // survives the reopen
})
```

- [ ] **Step 3: Run, verify fail.** Run: `cd frontend && npx vitest run src/chat/ChatStudio.test.tsx -t 'does NOT drop pre-build'` — Expected: FAIL (text missing — current seedRun overwrites).

- [ ] **Step 4: Make `seedRun` merge.** In `ChatStudio.tsx:seedRun`, replace the unconditional `nodes = [greeting, runMarker, ...restored]; saveThread(nodes)` with a `mergeSpine` call over the CURRENT persisted spine:

```ts
const restoredTurns = (chat ?? []).filter(t => t.content.trim().length > 0).map(t => ({ role: t.role, content: t.content }))
const nodes = mergeSpine({ local: loadThread(), serverTurns: restoredTurns, id, greeting: t('akis.greeting'), idea })
saveThread(nodes)
```
Keep the rest of `seedRun` (autoRan/drawerAutoOpened seeding, state resets, `syncUrl`) unchanged. Import `mergeSpine` + `loadThread`.

- [ ] **Step 5: Run, verify PASS.** Run: `cd frontend && npx vitest run src/chat/ChatStudio.test.tsx` — Expected: PASS.

- [ ] **Step 6: Backend test — startSession seeds `chat`.** In the sessions route test, POST startSession with a `chat` array and assert `getSession` returns it (bounded by `CHAT_TURNS_MAX`), and that it's written through the generic patch (no gate column touched).

```ts
it('startSession seeds session.chat from the client pre-build conversation (bounded)', async () => {
  const res = await app.inject({ method: 'POST', url: '/sessions', headers: authHeader, payload: { idea: 'note app', chat: [{ role: 'user', content: 'a note app', at: '' }] } })
  const { id } = res.json()
  const s = (await app.inject({ method: 'GET', url: `/sessions/${id}`, headers: authHeader })).json()
  expect(s.chat).toEqual([{ role: 'user', content: 'a note app', at: expect.any(String) }])
})
```

- [ ] **Step 7: Run, verify fail.** Run: `cd backend && npx vitest run src/api/sessions.routes.test.ts -t 'seeds session.chat'` — Expected: FAIL.

- [ ] **Step 8: Accept + seed `chat` server-side.** In `sessions.routes.ts` startSession: validate an optional `chat` (array of `{role:'user'|'assistant', content:string}`; cap to `CHAT_TURNS_MAX`; stamp `at`); pass it to session creation so the store persists `chat`. GATE-SAFE: `chat` is a non-gate column; do NOT route it near approval/gate minting.

- [ ] **Step 9: Send pre-build chat from FE.** In `ChatStudio.startBuild` (`:275`), pass the current conversation turns (from `historyForApi(loadThread(), t('akis.greeting'))`) as the new `chat` arg to `api.startSession`. Update `api/client.ts` `startSession` to accept the optional `chat` and include it in the POST body.

- [ ] **Step 10: Run all, verify PASS.** Run: `cd backend && npx vitest run src/api/sessions.routes.test.ts` and `cd frontend && npx vitest run src/chat`. Expected: PASS.

- [ ] **Step 11: Gate review + commit.** `akis-gate-keeper` on the backend diff. Then:

```bash
git add frontend/src/chat/ChatStudio.tsx frontend/src/chat/ChatStudio.test.tsx frontend/src/api/client.ts backend/src/api/sessions.routes.ts backend/src/api/server.ts backend/src/api/sessions.routes.test.ts
git commit -m "fix(studio): preserve conversation on return (merge spine on reopen + seed session.chat at build start)"
```

---

## Task 4: Bug A — themed scrollbar tokens + gutter

**Files:**
- Modify: `frontend/src/index.css` (add `.akis-scroll`)
- Modify: `frontend/src/chat/AkisChat.tsx:512` (apply `.akis-scroll` + `scrollbar-gutter`)
- Test: `frontend/src/chat/akis-chat.test.tsx` (DOM class assertion)

- [ ] **Step 1: Add the scrollbar utility to `index.css`.** Thin, themed, transparent-track, with stable gutter:

```css
/* One themed scroll surface for the studio — replaces the raw OS bar that fused to the drawer seam. */
.akis-scroll { scrollbar-width: thin; scrollbar-color: rgba(7,209,175,.45) transparent; scrollbar-gutter: stable; }
.akis-scroll::-webkit-scrollbar { width: 10px; height: 10px; }
.akis-scroll::-webkit-scrollbar-track { background: transparent; }
.akis-scroll::-webkit-scrollbar-thumb { background: rgba(7,209,175,.40); border-radius: 99px; border: 3px solid transparent; background-clip: padding-box; }
.akis-scroll::-webkit-scrollbar-thumb:hover { background: rgba(7,209,175,.6); }
```

- [ ] **Step 2: Write a DOM test asserting the scroll container carries `.akis-scroll`.** In `akis-chat.test.tsx`, render AkisChat and assert the scroll element has class `akis-scroll`.

```tsx
it('the transcript scroll container uses the themed .akis-scroll (gutter, no raw OS bar)', () => {
  const { container } = render(<AkisChat {...minimalProps} />)
  expect(container.querySelector('.akis-scroll.overflow-y-auto')).not.toBeNull()
})
```

- [ ] **Step 3: Run, verify fail.** Run: `cd frontend && npx vitest run src/chat/akis-chat.test.tsx -t 'akis-scroll'` — Expected: FAIL.

- [ ] **Step 4: Apply it.** In `AkisChat.tsx:512`, change `className="h-full space-y-3 overflow-y-auto"` → `className="akis-scroll h-full space-y-3 overflow-y-auto pr-1"`.

- [ ] **Step 5: Run, verify PASS.** Run as Step 3 — Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add frontend/src/index.css frontend/src/chat/AkisChat.tsx frontend/src/chat/akis-chat.test.tsx
git commit -m "fix(studio): themed thin scrollbar + stable gutter (no more bar fused to the drawer seam)"
```

---

## Task 5: De-layer the chat (flatten transcript) + seam gap

**Files:**
- Modify: `frontend/src/chat/AkisTranscript.tsx` (assistant turns plain; user turns tinted; cap measure)
- Modify: `frontend/src/chat/ChatStudio.tsx:535-556` (drop the elevated `<section>` card; add seam gap)
- Test: `frontend/src/chat/chat-components.test.tsx`

- [ ] **Step 1: Read** `AkisTranscript.tsx` fully and `ChatStudio.tsx:535-556`.

- [ ] **Step 2: Write tests for the flattened transcript.** Assistant message has NO border/bg box; user message keeps a tinted bubble.

```tsx
it('assistant turns render as plain text (no bordered box); user turns are tinted bubbles', () => {
  const { container } = render(<AkisTranscript nodes={[{ role: 'assistant', content: 'hi from akis' }, { role: 'user', content: 'hello' }]} /* + required props */ />)
  const assistant = screen.getByText('hi from akis').closest('div')!
  expect(assistant.className).not.toMatch(/border|bg-white\/\[0\.04\]/)     // plain
  const user = screen.getByText('hello').closest('div')!
  expect(user.className).toMatch(/from-\[#07D1AF\]|bg-/)                    // tinted
})
```

- [ ] **Step 3: Run, verify fail.** Run: `cd frontend && npx vitest run src/chat/chat-components.test.tsx -t 'plain text'` — Expected: FAIL (assistant currently boxed).

- [ ] **Step 4: Flatten assistant rendering.** In `AkisTranscript.tsx`, remove the `rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-2.5` wrapper on ASSISTANT messages → render plain text in a `max-w-[70ch] leading-relaxed text-slate-200` block (keep the AK avatar). Leave USER messages as the tinted gradient bubble. Keep `error` rows as-is. Keep structured blocks (spec/gate/run/trace) unchanged.

- [ ] **Step 5: Drop the elevated section card.** In `ChatStudio.tsx:548`, remove `rounded-2xl border border-white/12 bg-slate-900/60 shadow-[…] backdrop-blur-md` from the chat `<section>` (keep `flex min-h-0 flex-1 flex-col overflow-hidden` + the push-split padding). The conversation now sits on the page. Add a small right gap so the scroll column never abuts the drawer: keep the existing `lg:[padding-right:var(--preview-w)]` but add `lg:pr-[calc(var(--preview-w)+0.5rem)]` semantics via a 0.5rem gutter (or a `mr-2` on the inner content wrapper at `:551`).

- [ ] **Step 6: Run, verify PASS + visual self-check.** Run Step 3 test — Expected: PASS. Then `cd frontend && npx vitest run src/chat` (no regressions).

- [ ] **Step 7: Commit.**

```bash
git add frontend/src/chat/AkisTranscript.tsx frontend/src/chat/ChatStudio.tsx frontend/src/chat/chat-components.test.tsx
git commit -m "feat(studio): de-layer chat — plain assistant text, tinted user turns, on-page surface (no card-in-card)"
```

---

## Task 6: Composer = one rounded shell + model-picker popover + drop "CANLI"

**Files:**
- Modify: `frontend/src/chat/AkisChat.tsx` (composer region ~647-700)
- Modify: `frontend/src/chat/ModelChip.tsx` (drop live/demo badge)
- Modify: `frontend/src/chat/ModelPicker.tsx` (full-screen modal → anchored popover)
- Modify: `frontend/src/i18n/catalog.ts` (any string changes, TR+EN)
- Test: `frontend/src/chat/ModelChip.test.tsx` (new/updated), `frontend/src/chat/ModelPicker.test.tsx`, `frontend/src/chat/akis-chat.test.tsx`

- [ ] **Step 1: Read** `AkisChat.tsx` composer region, `ModelChip.tsx`, `ModelPicker.tsx` (note the `fixed inset-0` modal + focus-trap + `saveModelPref`).

- [ ] **Step 2: Test — ModelChip has no live/demo badge.** Assert the chip renders provider·model·effort but NOT the `chat.chip.live` pill.

```tsx
it('ModelChip renders the model label without a LIVE/DEMO status badge', () => {
  render(<ModelChip {...modelChipProps} />)
  expect(screen.queryByText(/CANLI|LIVE|DEMO/i)).toBeNull()
})
```

- [ ] **Step 3: Run, verify fail.** Run: `cd frontend && npx vitest run src/chat/ModelChip.test.tsx -t 'without a LIVE'` — Expected: FAIL.

- [ ] **Step 4: Remove the badge.** In `ModelChip.tsx`, delete the `live`/`demo`/`nokey` pill element next to the model name. Keep the "no key" signal but move it INTO the picker (a small "anahtar yok" line in the popover), not on the chip. Remove now-unused props/i18n only if nothing else uses them.

- [ ] **Step 5: Convert ModelPicker modal → anchored popover.** In `ModelPicker.tsx`, replace `fixed inset-0` overlay with an absolutely-anchored popover (anchored to the trigger; `role="dialog"`, keep the focus-trap + Escape-to-close + outside-click-close). Keep the provider+effort content and `saveModelPref`. Update `ModelPicker.test.tsx` to drive the popover (open via trigger, select, close); keep the persistence + a11y assertions.

- [ ] **Step 6: Rebuild the composer shell in `AkisChat.tsx`.** Wrap textarea + footer in one rounded container `rounded-2xl border border-white/12 bg-slate-900/70 backdrop-blur` matched to the conversation `max-w`. Footer row: left = `<ModelChip>` (opens the popover), right = send icon-button (↑) inside the same container. Remove the standalone provider chip + "CANLI" row above the form. Keep `UsageMeter` as a quiet element in the footer.

- [ ] **Step 7: Run all composer tests, verify PASS.** Run: `cd frontend && npx vitest run src/chat/ModelChip.test.tsx src/chat/ModelPicker.test.tsx src/chat/akis-chat.test.tsx` — Expected: PASS. Confirm i18n parity: `npx vitest run src/chat/model-picker-i18n.test.ts`.

- [ ] **Step 8: Commit.**

```bash
git add frontend/src/chat/AkisChat.tsx frontend/src/chat/ModelChip.tsx frontend/src/chat/ModelPicker.tsx frontend/src/chat/*.test.tsx frontend/src/i18n/catalog.ts
git commit -m "feat(studio): composer is one rounded shell with an in-composer model popover; drop the CANLI badge"
```

---

## Task 7: Agent roster — active highlight + live caption + progress summary

**Files:**
- Modify: `frontend/src/components/AgentRoster.tsx`
- Modify: `frontend/src/i18n/catalog.ts` (caption/progress keys, TR+EN)
- Test: `frontend/src/components/AgentRoster.test.tsx`

- [ ] **Step 1: Test — active agent is highlighted.** Build a view where Proto has an OPEN step (not done); assert its chip carries an "active" marker (e.g., `data-active="true"`) and others do not.

```tsx
it('highlights the currently-running agent', () => {
  const view = viewWith({ lanes: [{ steps: [{ agent: 'scribe', done: true, ok: true }, { agent: 'proto', done: false }] }] })
  render(<AgentRoster view={view} />)
  expect(screen.getByText('Proto').closest('[data-active]')?.getAttribute('data-active')).toBe('true')
})
```

- [ ] **Step 2: Run, verify fail.** Run: `cd frontend && npx vitest run src/components/AgentRoster.test.tsx -t 'currently-running'` — Expected: FAIL.

- [ ] **Step 3: Implement.** In `AgentRoster.tsx`, compute the single active role (the role whose most-recent step is `working`); render its chip with `data-active="true"` + a teal ring/glow + a short caption (`t('roster.caption.<role>')` or a generic "çalışıyor…"); collapse `done` chips to a quiet style. Optionally render a compact progress summary "Building · Proto · k/n · mm:ss" (reuse the `StartingElapsed` ticker-leaf so only the badge re-renders). Add TR+EN keys.

- [ ] **Step 4: Run, verify PASS.** Run Step 1 test + full file — Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add frontend/src/components/AgentRoster.tsx frontend/src/components/AgentRoster.test.tsx frontend/src/i18n/catalog.ts
git commit -m "feat(studio): roster highlights the active agent with a live caption + progress"
```

---

## Task 8: Sticky "build running" status bar

**Files:**
- Modify: `frontend/src/chat/ChatStudio.tsx` (top of conversation column)
- Modify: `frontend/src/i18n/catalog.ts` (TR+EN)
- Test: `frontend/src/chat/ChatStudio.test.tsx`

- [ ] **Step 1: Test — the sticky bar shows only while in-flight.** Render with an in-flight active view → bar present with the active agent + Stop; render terminal → bar absent.

```tsx
it('shows a sticky build-status bar only while a run is in flight', () => {
  const { rerender } = render(<ChatStudio api={makeFakeApi()} />)
  // simulate in-flight via the active view (status 'running') and assert role=status bar present:
  // (drive through the same path the component uses to set activeView)
  expect(screen.queryByRole('status', { name: /derleniyor|building/i })).toBeNull()  // idle: absent
})
```

- [ ] **Step 2: Run, verify fail/red-as-designed.** Run: `cd frontend && npx vitest run src/chat/ChatStudio.test.tsx -t 'sticky build-status'`.

- [ ] **Step 3: Implement.** Add a thin sticky `role="status"` bar at the top of the conversation column rendered only when the active run is non-terminal (reuse `inFlight`/`status`): active agent + phase + elapsed (`StartingElapsed`-style leaf) + a Stop button wired to the existing `cancelRun`. `motion-safe` only.

- [ ] **Step 4: Run, verify PASS.**

- [ ] **Step 5: Commit.**

```bash
git add frontend/src/chat/ChatStudio.tsx frontend/src/chat/ChatStudio.test.tsx frontend/src/i18n/catalog.ts
git commit -m "feat(studio): sticky build-status bar so an in-flight run never reads as frozen"
```

---

## Task 9: Cohesion tokens + "+ Yeni sohbet" anchored in the history rail

**Files:**
- Modify: `frontend/src/index.css` (shared surface/radius/border tokens or Tailwind @apply utilities)
- Modify: `frontend/src/chat/HistoryMenu.tsx` (top-anchored New chat) + `frontend/src/chat/ChatStudio.tsx:425`
- Test: `frontend/src/chat/history.test.tsx`

- [ ] **Step 1: Test — New chat is the first item in the History menu, always available.** Open the menu, assert the first row is "Yeni sohbet" and clicking it calls `onNewChat`.

```tsx
it('History menu anchors "New chat" at the top and triggers a new build', async () => {
  const onNew = vi.fn()
  render(<HistoryMenu builds={[]} onOpen={() => {}} onNewChat={onNew} />)
  await userEvent.click(screen.getByRole('button', { name: /geçmiş|history/i }))
  const items = screen.getAllByRole('menuitem')
  expect(items[0]).toHaveTextContent(/yeni sohbet|new chat/i)
  await userEvent.click(items[0]); expect(onNew).toHaveBeenCalled()
})
```

- [ ] **Step 2: Run, verify fail.** Run: `cd frontend && npx vitest run src/chat/history.test.tsx -t 'anchors'` — Expected: FAIL.

- [ ] **Step 3: Implement.** Add an `onNewChat` prop to `HistoryMenu` and render a top-anchored "Yeni sohbet" menuitem (compose icon + label). In `ChatStudio.tsx`, pass `newChat` to `HistoryMenu` and remove the standalone header New-chat button (or keep it only ≥lg). Add a shared radius/border token pass across roster/drawer/tabs/metrics (one border width; 8–12px radii) — token utilities in `index.css`.

- [ ] **Step 4: Run, verify PASS.**

- [ ] **Step 5: Commit.**

```bash
git add frontend/src/chat/HistoryMenu.tsx frontend/src/chat/ChatStudio.tsx frontend/src/chat/history.test.tsx frontend/src/index.css
git commit -m "feat(studio): anchor New chat in the history rail + standardize surface tokens"
```

---

## Task 10: Mobile-first responsive (systematic) + drag-resizable preview bottom-sheet + integrated Preview open/close

**[OWNER-EMPHASIZED 2026-06-09, from a live screenshot]:**
- **Preview OPEN/CLOSE affordance must be integrated, simple, usable** — redesign the drawer toggle. Desktop: a clean "Önizleme" toggle (icon + label) in the header/roster cluster opens the closed drawer (replace the bare edge-tab sliver); the in-drawer ✕ closes it — ONE consistent, discoverable control, never a hidden sliver. Mobile: a clear FAB + the bottom-sheet grip.
- **Set up responsiveness SYSTEMATICALLY** — one shared breakpoint scale + container rules applied consistently across nav, roster, conversation, composer, and drawer; not ad-hoc per element. Verify carefully at 320/375/414/768/1024/1440.

**Files:**
- Modify: `frontend/src/components/PreviewDrawer.tsx` (mobile bottom-sheet snap points + the open/close affordance)
- Modify: `frontend/src/chat/ChatStudio.tsx` / `frontend/src/chat/HistoryMenu.tsx` / `frontend/src/components/AgentRoster.tsx` (collapse below lg; the desktop "Önizleme" open toggle)
- Test: `frontend/src/components/PreviewDrawer.test.tsx`

- [ ] **Step 1: Read** `PreviewDrawer.tsx` (the existing below-lg overlay + body scroll-lock at ~184-210).

- [ ] **Step 2: Test — the mobile sheet has snap points and the grip changes height.** Assert (in a jsdom/mobile-width context) the sheet exposes peek/half/full snap state and dragging the grip updates a height/snap attribute that persists.

```tsx
it('mobile preview sheet exposes peek/half/full snaps and persists the chosen snap', () => {
  render(<PreviewDrawer open ratio={0.4} {...drawerProps} />)
  const sheet = screen.getByTestId('preview-sheet')
  expect(sheet).toHaveAttribute('data-snap')             // one of peek|half|full
  // simulate grip activation to 'full' and assert persistence key written
})
```

- [ ] **Step 3: Run, verify fail.** Run: `cd frontend && npx vitest run src/components/PreviewDrawer.test.tsx -t 'snaps'` — Expected: FAIL.

- [ ] **Step 4: Implement the bottom-sheet.** Below `lg`, render the drawer as a bottom-sheet with a drag grip and three snap points (peek = grip+tabs; half = 50vh; full = ~92vh), `data-snap` + persisted last snap (localStorage), `overscroll-behavior: contain` + body scroll-lock (already present) while half/full. Tabs (Önizleme/Kod/Güven) + metrics usable at each snap. `prefers-reduced-motion` → instant snap. Above `lg`, keep the side split. Collapse roster → horizontal scroll strip; History/New chat → menu button below lg.

- [ ] **Step 5: Run, verify PASS.**

- [ ] **Step 6: Commit.**

```bash
git add frontend/src/components/PreviewDrawer.tsx frontend/src/chat/ChatStudio.tsx frontend/src/chat/HistoryMenu.tsx frontend/src/components/AgentRoster.tsx frontend/src/components/PreviewDrawer.test.tsx
git commit -m "feat(studio): mobile-first responsive — drag-resizable preview bottom-sheet (peek/half/full)"
```

---

## Task 11: Phase-1 integration verification (live)

- [ ] **Step 1:** Run the full suites: `cd frontend && npx vitest run` and `cd backend && npx vitest run`. Expected: green (TR+EN i18n parity included).
- [ ] **Step 2:** `cd frontend && npx tsc --noEmit` and `cd backend && npx tsc --noEmit` — Expected: clean.
- [ ] **Step 3:** Dispatch `akis-reviewer` over the full Phase-1 diff (correctness/lifecycle/perf/i18n/regression) and `akis-gate-keeper` over the backend diff. Address any must-fix.
- [ ] **Step 4: Live-verify** in the real app (Chrome via Playwright-MCP per owner preference, or `chrome-devtools` MCP): dev-login + a seeded/real build → confirm (a) no scrollbar fused to the drawer; (b) open "+ Yeni sohbet" → return via History → pre-build + post-build conversation fully intact; (c) Scribe reads "tamam" on a chat build; (d) composer shell + in-composer model popover, no "CANLI"; (e) active agent highlighted + sticky bar; (f) responsive at 320/375/768/1024 with the bottom-sheet snaps. Use `superpowers:verification-before-completion` — evidence before "done".
- [ ] **Step 5:** Update the spec's phase status; report results.

---

## Self-Review

**Spec coverage:** P1.1 (Task 5) · P1.2 (Task 4) · P1.3 (Task 6) · P1.4 (Tasks 2-3) · P1.5 (Task 1) · P1.6 (Task 7) · P1.7 (Task 8) · P1.8 (Task 9) · P1.9 (Task 10) · integration (Task 11). All Phase-1 items mapped.

**Placeholder scan:** UI tasks (5,6,7,10) intentionally instruct "read the current file first" because the exact current markup must be read at execution time; the behavior, target file:line, test code, and key snippets are concrete. Logic tasks (1,2,3) carry complete code. No "TBD/handle edge cases" left.

**Type consistency:** `mergeSpine({local,serverTurns,id,greeting,idea})` is defined in Task 2 and called identically in Task 3. `presenceOf` returns `'idle'|'working'|'done'|'failed'` (existing `AgentPresence`); the scribe fallback returns `'done'`. `view.gates.specApproval.state` matches `viewModel.ts:81-83`.

**Risk notes:** Tasks 1 & 3 touch the backend — both are observational/additive and MUST pass `akis-gate-keeper`. The exact `bus.emit` payload shape (Task 1) and `startSession` signature (Task 3) are read at execution time to match the real API.
