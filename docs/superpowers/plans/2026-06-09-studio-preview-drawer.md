# Studio Preview Drawer (resizable · responsive · mobile/web toggle) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the AKIS studio preview pane into a chat-first, resizable, responsive right **drawer** (closed by default, slides in on first artifact) with a **mobile/web device toggle**, fixing the double-scroll, empty-space, and UI-shift bugs — frontend-only, gate-safe.

**Architecture:** Replace the two-column CSS grid in `ChatStudio.tsx` with a `relative` shell + an `absolute` right drawer sibling. Desktop = push-split (`paddingRight: var(--preview-w)` shifts the centered chat); mobile (`<lg`) = full-screen overlay reusing `ModelPicker`'s modal a11y. One CSS var `--preview-w` drives both chat padding and drawer width; a zero-dep `useResizable` hook writes it via Pointer-capture + rAF and persists a ratio. The drawer holds two scroll regions (gate cards / PreviewPanel) so each owns one scrollbar. A `DeviceFrame` wraps the existing iframe and sets its **logical width** per preset.

**Tech Stack:** React 18 + TypeScript (strict, `exactOptionalPropertyTypes`), Tailwind, Vitest + Testing Library, the repo i18n (`t()` + `fill()`), Pointer Events, localStorage.

**Source of truth:** `docs/superpowers/specs/2026-06-09-preview-drawer-design.md` (esp. §9 wiring, §13 corrections, §14 v1 scope). Branch: `feat/studio-preview-drawer`.

**Sacred (do NOT touch):** the chat spine (`AkisChat key={threadKey}` slot), the 5 gates (render in chat), SSE/fold, the iframe `sandbox="allow-scripts allow-forms allow-popups"` + `allow="clipboard-write"` (NO `allow-same-origin`), the `url.startsWith('/preview/')` allowlist, and all gate-route client calls. Everything here is view-state.

**Verify each task:** `cd frontend && npx tsc -p tsconfig.json --noEmit` (must be exit 0) + the task's vitest. Commit after each green task. Final: live-verify in the Brave automation profile + an `akis-gate-keeper` pass.

---

### Task 1: i18n keys for the drawer + device toggle

**Files:**
- Modify: `frontend/src/i18n/catalog.ts` (add keys to BOTH `en` and `tr`)
- Test: `frontend/src/i18n/aw-i18n-parity.test.tsx` already asserts en/tr key parity — rely on it.

- [ ] **Step 1: Add keys to both locales.** In `en` and `tr` objects add:

```
// en
'preview.open': 'Open preview', 'preview.close': 'Close preview',
'preview.resize': 'Resize preview', 'preview.resizeValue': 'Preview {n}% of width',
'preview.device.responsive': 'Responsive', 'preview.device.mobile': 'Mobile', 'preview.device.desktop': 'Desktop',
'preview.device.label': 'Preview width', 'preview.device.unit': 'px',
// tr
'preview.open': 'Önizlemeyi aç', 'preview.close': 'Önizlemeyi kapat',
'preview.resize': 'Önizlemeyi yeniden boyutlandır', 'preview.resizeValue': 'Önizleme genişliğin %{n}’i',
'preview.device.responsive': 'Esnek', 'preview.device.mobile': 'Mobil', 'preview.device.desktop': 'Masaüstü',
'preview.device.label': 'Önizleme genişliği', 'preview.device.unit': 'px',
```

- [ ] **Step 2: Run parity + typecheck.** `cd frontend && npx vitest run src/i18n/aw-i18n-parity && npx tsc -p tsconfig.json --noEmit` → PASS, exit 0. (`StringKey` now includes the new keys.)
- [ ] **Step 3: Commit.** `git add frontend/src/i18n/catalog.ts && git commit -m "feat(i18n): preview-drawer + device-toggle keys (tr+en)"`

---

### Task 2: `useResizable` hook (CSS-var + pointer-capture + rAF + keyboard + persisted ratio)

**Files:**
- Create: `frontend/src/chat/useResizable.ts`
- Test: `frontend/src/chat/useResizable.test.ts`

Contract: owns the open/width state for the drawer. Width is a **ratio** (0..1 of the container) persisted to localStorage `akis_preview_drawer` as `{ ratio, open }`. Exposes the value + handlers for a `role="separator"` handle. Writing the live width to the DOM is the CALLER's job via the returned `ratio` (caller sets the CSS var) — the hook stays render-light by coalescing pointer moves through rAF and only committing React state on pointerup/keyup.

- [ ] **Step 1: Write failing tests.**

```ts
import { renderHook, act } from '@testing-library/react'
import { useResizable, clampRatio, MIN_PX, loadDrawer, RATIO_DEFAULT } from './useResizable.js'

test('clampRatio respects min px floor and max fraction', () => {
  expect(clampRatio(0.01, 2000)).toBeCloseTo(MIN_PX / 2000) // floored to 30rem(480px)/2000
  expect(clampRatio(0.99, 2000)).toBeLessThanOrEqual(0.6)    // max 60%
})
test('keyboard widen/narrow steps 5% and clamps', () => {
  const { result } = renderHook(() => useResizable({ containerWidth: 2000 }))
  act(() => result.current.openDrawer())
  const start = result.current.ratio
  act(() => result.current.onKeyDown({ key: 'ArrowLeft', preventDefault(){} } as any))
  expect(result.current.ratio).toBeCloseTo(clampRatio(start + 0.05, 2000))
})
test('persists ratio+open and reloads', () => {
  localStorage.clear()
  const { result, unmount } = renderHook(() => useResizable({ containerWidth: 1600 }))
  act(() => { result.current.openDrawer(); result.current.commitRatio(0.5) })
  unmount()
  expect(loadDrawer().open).toBe(true)
  expect(loadDrawer().ratio).toBeCloseTo(0.5)
})
test('Enter toggles collapse and restores last width', () => {
  const { result } = renderHook(() => useResizable({ containerWidth: 1600 }))
  act(() => { result.current.openDrawer(); result.current.commitRatio(0.5) })
  act(() => result.current.onKeyDown({ key: 'Enter', preventDefault(){} } as any))
  expect(result.current.open).toBe(false)
  act(() => result.current.onKeyDown({ key: 'Enter', preventDefault(){} } as any))
  expect(result.current.open).toBe(true); expect(result.current.ratio).toBeCloseTo(0.5)
})
```

- [ ] **Step 2: Run → FAIL** (`useResizable` not found). `cd frontend && npx vitest run src/chat/useResizable`
- [ ] **Step 3: Implement** `useResizable.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from 'react'

const KEY = 'akis_preview_drawer'
export const MIN_PX = 480           // 30rem
export const MAX_FRACTION = 0.6
const CHAT_FLOOR_PX = 448           // 28rem — chat never narrower than this
export const RATIO_DEFAULT = 0.46
const STEP = 0.05

export interface DrawerState { ratio: number; open: boolean }
export function loadDrawer(): DrawerState {
  try { const j = JSON.parse(localStorage.getItem(KEY) || '{}'); 
    return { ratio: typeof j.ratio === 'number' ? j.ratio : RATIO_DEFAULT, open: !!j.open } }
  catch { return { ratio: RATIO_DEFAULT, open: false } }
}
function save(s: DrawerState) { try { localStorage.setItem(KEY, JSON.stringify(s)) } catch { /* ignore */ } }

/** Clamp a ratio to [MIN_PX, min(MAX_FRACTION, 1 - chatFloor)] for a given container width. */
export function clampRatio(ratio: number, containerWidth: number): number {
  if (!containerWidth) return ratio
  const minR = MIN_PX / containerWidth
  const maxR = Math.min(MAX_FRACTION, 1 - CHAT_FLOOR_PX / containerWidth)
  return Math.min(Math.max(ratio, minR), Math.max(minR, maxR))
}

export function useResizable({ containerWidth }: { containerWidth: number }) {
  const init = loadDrawer()
  const [open, setOpen] = useState(init.open)
  const [ratio, setRatio] = useState(init.ratio)
  const lastOpenRatio = useRef(init.ratio)
  const dragging = useRef(false)

  // re-clamp against the CURRENT container whenever it changes (M1)
  useEffect(() => { if (containerWidth) setRatio(r => clampRatio(r, containerWidth)) }, [containerWidth])
  useEffect(() => { save({ ratio, open }) }, [ratio, open])

  const openDrawer = useCallback(() => setOpen(true), [])
  const closeDrawer = useCallback(() => setOpen(false), [])
  const commitRatio = useCallback((r: number) => {
    const c = clampRatio(r, containerWidth); setRatio(c); if (open) lastOpenRatio.current = c
  }, [containerWidth, open])

  const onKeyDown = useCallback((e: { key: string; preventDefault(): void }) => {
    if (e.key === 'Enter') { e.preventDefault(); setOpen(o => { if (o) return false; setRatio(clampRatio(lastOpenRatio.current, containerWidth)); return true }); return }
    const dir = e.key === 'ArrowLeft' || e.key === 'End' ? +1 : e.key === 'ArrowRight' || e.key === 'Home' ? -1 : 0
    if (!dir) return; e.preventDefault(); commitRatio(ratio + dir * STEP)
  }, [ratio, containerWidth, commitRatio])

  return { open, ratio, dragging, openDrawer, closeDrawer, commitRatio, setRatioLive: setRatio, onKeyDown }
}
```

- [ ] **Step 4: Run → PASS.** `cd frontend && npx vitest run src/chat/useResizable && npx tsc -p tsconfig.json --noEmit`
- [ ] **Step 5: Commit.** `git add frontend/src/chat/useResizable.* && git commit -m "feat(studio): useResizable — persisted ratio, clamp, keyboard splitter"`

---

### Task 3: `DeviceFrame` — device toggle + iframe logical width

**Files:**
- Create: `frontend/src/components/DeviceFrame.tsx`
- Test: `frontend/src/components/DeviceFrame.test.tsx`

Wraps the EXISTING preview iframe element (passed as `children`) and sets its container's logical width per device preset. Presets (v1): `responsive` (100%), `mobile` (390), `desktop` (`min(1280, paneWidth)` + horizontal scroll). NO rotate, NO tablet, NO transform-scale (v2). Centered with `mx-auto`, dark letterbox margins. Replaces `PreviewPanel`'s `max-w-[1100px]`.

- [ ] **Step 1: Write failing tests.**

```tsx
import { render, screen } from '@testing-library/react'
import { DeviceFrame, DEVICE_WIDTHS } from './DeviceFrame.js'
import { renderI18n } from '../test/renderI18n.js' // existing helper

test('mobile preset sets a 390px logical width on the frame', () => {
  renderI18n(<DeviceFrame device="mobile" paneWidth={900} onDevice={() => {}} tab="preview"><iframe title="x" /></DeviceFrame>)
  const frame = screen.getByTestId('device-frame')
  expect(frame.style.width).toBe('390px')
})
test('responsive preset is full width', () => {
  renderI18n(<DeviceFrame device="responsive" paneWidth={900} onDevice={() => {}} tab="preview"><iframe title="x" /></DeviceFrame>)
  expect(screen.getByTestId('device-frame').style.width).toBe('100%')
})
test('device toggle is hidden unless the active tab is preview (M4)', () => {
  const { rerender } = renderI18n(<DeviceFrame device="responsive" paneWidth={900} onDevice={() => {}} tab="code"><iframe title="x" /></DeviceFrame>)
  expect(screen.queryByRole('group', { name: /preview width|önizleme genişliği/i })).toBeNull()
})
```

- [ ] **Step 2: Run → FAIL.** `cd frontend && npx vitest run src/components/DeviceFrame`
- [ ] **Step 3: Implement** `DeviceFrame.tsx`:

```tsx
import type { ReactNode } from 'react'
import { useI18n } from '../i18n/I18nContext.js'

export type Device = 'responsive' | 'mobile' | 'desktop'
export const DEVICE_WIDTHS: Record<Device, number | null> = { responsive: null, mobile: 390, desktop: 1280 }

export function DeviceFrame(
  { device, onDevice, paneWidth, tab, children }:
  { device: Device; onDevice: (d: Device) => void; paneWidth: number; tab: string; children: ReactNode },
) {
  const { t } = useI18n()
  const w = DEVICE_WIDTHS[device]
  const widthStyle = w === null ? '100%' : `${device === 'desktop' ? Math.min(w, Math.max(0, paneWidth)) : w}px`
  const opts: Device[] = ['responsive', 'mobile', 'desktop']
  const labelFor = (d: Device) => d === 'responsive' ? t('preview.device.responsive') : d === 'mobile' ? t('preview.device.mobile') : t('preview.device.desktop')
  return (
    <div className="flex h-full flex-col">
      {tab === 'preview' && (
        <div className="mb-2 flex items-center justify-end gap-2">
          <div role="group" aria-label={t('preview.device.label')} className="flex rounded-lg border border-white/10 bg-white/[0.03] p-0.5 text-xs">
            {opts.map(d => (
              <button key={d} type="button" aria-pressed={device === d} aria-label={labelFor(d)} onClick={() => onDevice(d)}
                className={`rounded-md px-2 py-1 ${device === d ? 'bg-white/10 text-slate-100' : 'text-slate-400 hover:text-slate-200'}`}>
                {d === 'responsive' ? '↔' : d === 'mobile' ? '▢' : '▭'}
              </button>
            ))}
          </div>
          {w !== null && <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] tabular-nums text-slate-400">{w} {t('preview.device.unit')}</span>}
        </div>
      )}
      <div className="relative flex-1 overflow-auto bg-slate-950">
        <div data-testid="device-frame" className="mx-auto h-full" style={{ width: widthStyle }}>
          {children}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run → PASS** + tsc. `cd frontend && npx vitest run src/components/DeviceFrame && npx tsc -p tsconfig.json --noEmit`
- [ ] **Step 5: Commit.** `git add frontend/src/components/DeviceFrame.* && git commit -m "feat(studio): DeviceFrame — responsive/mobile/desktop iframe width toggle"`

---

### Task 4: PreviewPanel — two-region height + bounded iframe + DeviceFrame integration

**Files:**
- Modify: `frontend/src/components/PreviewPanel.tsx` (root `min-h-0`; the iframe-band wrapper drops `max-w-[1100px]` and `min-h-[clamp(...)]` → wrap the existing `<iframe>` verbatim in `DeviceFrame`; lift `device` state up via props)
- Test: `frontend/src/components/components.test.tsx` (extend) — assert ONE scroll container chain + iframe sandbox unchanged.

- [ ] **Step 1: Write failing test** (Code tab yields a single scroll owner; iframe attrs preserved):

```tsx
test('preview iframe keeps its sandbox and clipboard-write allow (gate-safe)', () => {
  const view = makeView({ preview: { ready: true, url: '/preview/abc/' } }) // existing test helper
  const { container } = renderI18n(<PreviewPanel view={view} device="responsive" onDevice={() => {}} canRun onRun={() => {}} />)
  const f = container.querySelector('iframe')!
  expect(f.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-popups')
  expect(f.getAttribute('allow')).toBe('clipboard-write')
})
```

- [ ] **Step 2: Run → FAIL** (PreviewPanel doesn't accept `device`/`onDevice` yet).
- [ ] **Step 3: Implement.** Add `device: Device; onDevice: (d:Device)=>void` to `PreviewPanel` props. Set the panel root (line ~64) to `flex h-full min-h-0 flex-col gap-3`. Replace the iframe-band block (`:136`–`:165` region): remove the fixed `min-h-[clamp(16rem,55vh,42rem)]` wrapper height and the iframe's `mx-auto max-w-[1100px]`; instead render the **existing iframe element verbatim** (same `src`, `sandbox`, `allow`, `onLoad`) as the child of `<DeviceFrame device={device} onDevice={onDevice} paneWidth={paneWidthRef} tab={activeTab}>`. Keep the browser-chrome header, the loaded-skeleton, the error card, demo/verified badges, Run control, and TestStats exactly as-is. Measure `paneWidth` with a `ref` + `ResizeObserver` (read-only; no scaling) OR pass it down from the drawer.
- [ ] **Step 4: Run → PASS** + tsc + the full components test file. `cd frontend && npx vitest run src/components/components && npx tsc -p tsconfig.json --noEmit`
- [ ] **Step 5: Commit.** `git add frontend/src/components/PreviewPanel.tsx frontend/src/components/components.test.tsx && git commit -m "feat(studio): PreviewPanel two-region height + DeviceFrame (sandbox verbatim)"`

---

### Task 5: `PreviewDrawer` — desktop push-split shell + resize separator + edge-tab

**Files:**
- Create: `frontend/src/components/PreviewDrawer.tsx`
- Test: `frontend/src/components/PreviewDrawer.test.tsx`

Owns: the slide-in container (`absolute right-0 inset-y-0`, `translateX(0|100%)`), the **left-edge `role="separator"` handle** (wired to `useResizable.onKeyDown` + pointer drag writing `--preview-w`), the two scroll regions (region A = gate cards via `children.cards` `shrink-0 overflow-y-auto max-h-[50vh]`; region B = preview via `children.preview` `flex-1 min-h-0`), the close (✕), and the **collapsed edge-tab** (carries the verified dot — L3). Desktop only here; mobile in Task 6.

- [ ] **Step 1: Write failing tests** (separator a11y + open/close translate + drag sets var):

```tsx
test('separator exposes the W3C splitter contract', () => {
  renderDrawer({ open: true, ratio: 0.46 })
  const sep = screen.getByRole('separator')
  expect(sep).toHaveAttribute('aria-orientation', 'vertical')
  expect(sep).toHaveAttribute('aria-valuenow', '46')
  expect(sep).toHaveAttribute('aria-valuemin'); expect(sep).toHaveAttribute('aria-valuemax')
})
test('closed drawer is translated off and shows the edge-tab', () => {
  renderDrawer({ open: false })
  expect(screen.getByTestId('preview-drawer')).toHaveStyle({ transform: 'translateX(100%)' })
  expect(screen.getByRole('button', { name: /open preview|önizlemeyi aç/i })).toBeInTheDocument()
})
test('ArrowLeft on the separator widens (calls onKeyDown)', async () => {
  const onKeyDown = vi.fn(); renderDrawer({ open: true, onKeyDown })
  screen.getByRole('separator').focus()
  await userEvent.keyboard('{ArrowLeft}'); expect(onKeyDown).toHaveBeenCalled()
})
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `PreviewDrawer.tsx` (desktop): a `<aside data-testid="preview-drawer" style={{ transform: open?'translateX(0)':'translateX(100%)', width: 'var(--preview-w)' }} className="absolute right-0 inset-y-0 hidden lg:flex ...transition-transform...">`. Left-edge handle: `<div role="separator" tabIndex={0} aria-orientation="vertical" aria-controls={id} aria-valuenow={Math.round(ratio*100)} aria-valuemin={25} aria-valuemax={60} aria-valuetext={fill(t('preview.resizeValue'),{n:String(Math.round(ratio*100))})} onKeyDown={onKeyDown} onPointerDown={...setPointerCapture, dragging=true...} className="absolute left-0 inset-y-0 w-3 cursor-col-resize ...">`. During drag: `iframe{pointer-events:none}` via a class on the drawer + write `--preview-w` once per rAF from the latest clientX; on `pointerup` call `commitRatio`. Body = `flex flex-col h-full`: region A `shrink-0 overflow-y-auto max-h-[50vh]` ({cards}) + region B `flex-1 min-h-0` ({preview}). Edge-tab when closed: a thin right-edge button (`aria-label={t('preview.open')}`) with the verified dot.
- [ ] **Step 4: Run → PASS** + tsc.
- [ ] **Step 5: Commit.** `git commit -am "feat(studio): PreviewDrawer desktop push-split + resize separator + edge-tab"`

---

### Task 6: PreviewDrawer mobile overlay (reuse `ModelPicker` a11y)

**Files:**
- Modify: `frontend/src/components/PreviewDrawer.tsx` (add the `<lg` overlay branch + a floating FAB)
- Reference: `frontend/src/components/ModelPicker.tsx:45-56` (Escape close, focus-into-on-open, focus-restore-on-close)
- Test: `frontend/src/components/PreviewDrawer.test.tsx` (extend)

- [ ] **Step 1: Write failing tests** (mobile dialog a11y):

```tsx
test('mobile overlay is a focus-trapped dialog that closes on Escape', async () => {
  setViewport(390)
  renderDrawer({ open: true })
  const dlg = screen.getByRole('dialog'); expect(dlg).toHaveAttribute('aria-modal', 'true')
  await userEvent.keyboard('{Escape}'); expect(onClose).toHaveBeenCalled()
})
test('persisted open=true does NOT auto-show the mobile overlay on load (M1)', () => {
  setViewport(390); localStorage.setItem('akis_preview_drawer', JSON.stringify({ ratio: 0.5, open: true }))
  renderDrawer({}) // initial
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByRole('button', { name: /open preview|önizlemeyi aç/i })).toBeInTheDocument() // FAB
})
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** Mirror `ModelPicker`: when `<lg` and `open`, render `<div role="dialog" aria-modal="true" className="fixed inset-0 z-50 lg:hidden ...">` with a scrim, the same two regions, an X, `overscroll-behavior:contain` + body scroll-lock; on mount focus the panel, on close restore focus to the FAB; Escape → `onClose`. The FAB (`fixed bottom-4 right-4 lg:hidden`, `aria-label={t('preview.open')}`, carries verified dot) toggles open. On `<lg`, ignore persisted `open:true` for initial show (require a FAB tap) — pass an `allowAutoOpen` that the parent sets false on small screens.
- [ ] **Step 4: Run → PASS** + tsc.
- [ ] **Step 5: Commit.** `git commit -am "feat(studio): PreviewDrawer mobile overlay (ModelPicker a11y: dialog/Escape/focus-trap/scroll-lock)"`

---

### Task 7: ChatStudio integration — shell, drawer mount, auto-open on `ready`, #35 ref

**Files:**
- Modify: `frontend/src/chat/ChatStudio.tsx` (shell `:402`; drop the grid `:427`; move the `<aside>` cards `:438-485` + `PreviewPanel` into `PreviewDrawer`; `useResizable`; the `--preview-w`/`paddingRight` wiring; auto-open effect; the `drawerAutoOpened` ref in `seedRun`)
- Test: `frontend/src/chat/ChatStudio.test.tsx` (or a new `ChatStudio.drawer.test.tsx`)

- [ ] **Step 1: Write failing tests.**

```tsx
test('drawer auto-opens when preview becomes ready (not on starting)', async () => {
  const { setView } = renderStudioWithActiveRun()
  setView({ preview: { starting: true } }); expect(screen.queryByTestId('preview-drawer-open')).toBeNull()
  setView({ preview: { ready: true, url: '/preview/x/' } })
  await screen.findByTestId('preview-drawer-open')
})
test('reopening a finished build does NOT auto-open the drawer (#35)', async () => {
  renderStudioReopen({ verified: true }) // seedRun path
  await tick(); expect(screen.queryByTestId('preview-drawer-open')).toBeNull()
})
test('chat stays full-width (no right padding) when the drawer is closed', () => {
  const { root } = renderStudioWithActiveRun()
  expect(root.style.getPropertyValue('--preview-w')).toBe('0px')
})
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.**
  - Root (`:402`): keep `flex flex-col lg:h-[calc(100dvh-8.5rem)]`; add `relative`; measure its width with a `ref`+`ResizeObserver` → `containerWidth` for `useResizable`.
  - Replace the grid wrapper (`:427`): a single `relative flex min-h-0 flex-1` whose inner chat container gets `style={{ paddingRight: open ? 'var(--preview-w)' : 0 }}` (lg only — guard with a `lg:` via a class toggling the var to 0 below lg). Set `--preview-w` on this element from `ratio*containerWidth` (px) whenever not dragging; during drag the handle writes it directly.
  - Keep the chat `<section>` (`:428`) at its exact tree position with `min-h-0 flex-1` + its `mx-auto max-w-*`.
  - Render `<PreviewDrawer open={open} ratio={ratio} onKeyDown={onKeyDown} onClose={closeDrawer} cards={<>…the moved Trust/Publish/Proposals/ExternalWrite cards with their `!sessionGone && isDone` guards + props verbatim…</>} preview={<PreviewPanel view={activeView} device={device} onDevice={setDevice} canRun={canRun} onRun={()=>void runApp()} … />} />` as a SIBLING of the chat (not inside it).
  - `device` state: `useState<Device>('responsive')`.
  - **Auto-open (H2):** `useEffect` watching `activeView.preview.ready` — if `ready` and `drawerAutoOpened.current !== activeSessionId` → `openDrawer(); drawerAutoOpened.current = activeSessionId`.
  - **#35 (M5):** add `const drawerAutoOpened = useRef<string|undefined>(undefined)`. In `seedRun` (`:152`, alongside `autoRan.current = id`) add `drawerAutoOpened.current = id` so a reopen is pre-seeded (no auto-open).
  - On `<lg`, pass `allowAutoOpen={false}` to suppress overlay on load (M1).
- [ ] **Step 4: Run → PASS** + tsc + the full chat test dir. `cd frontend && npx vitest run src/chat && npx tsc -p tsconfig.json --noEmit`
- [ ] **Step 5: Commit.** `git commit -am "feat(studio): mount PreviewDrawer — push-split shell, auto-open on ready, #35 drawerAutoOpened ref"`

---

### Task 8: Full suite + live-verify + gate-keeper

- [ ] **Step 1: Full FE suite + typecheck + build.** `cd frontend && npx vitest run && npx tsc -p tsconfig.json --noEmit && npm run build` → all green.
- [ ] **Step 2: Live-verify** (Brave automation profile, dev server): drive a real build → during build the chat is full-width, drawer closed, NO empty band; on preview-ready the drawer auto-opens; resize via drag AND keyboard (separator focus + arrows) works and persists across reload; device toggle Responsive/Mobil/Masaüstü changes the iframe width; the **Kod tab shows ONE scrollbar**; close → chat returns full-width; reopen a finished build → drawer does NOT auto-open; shrink to <lg → drawer is a focus-trapped dialog (Escape closes, FAB reopens). Capture before/after screenshots.
- [ ] **Step 3: `akis-gate-keeper` review** of the diff — confirm zero gate/SSE/sandbox/chat-spine impact. Address any finding.
- [ ] **Step 4: Final commit / ready for review.** `git commit -am "test(studio): full suite green + live-verified drawer"` (if any test tweaks).

---

## Notes
- **DRY:** reuse `ModelPicker`'s modal a11y, the `rAF` idiom from `useSmoothText`/`useLiveChat`, `fill()` from the i18n layer, the existing `Card/SectionTitle/Stat` kit.
- **YAGNI (deferred to v2, do NOT build):** rotate, Tablet 768 preset, desktop `ResizeObserver` transform-scale-to-fit.
- **Gate-safety:** no route/tool/handler/token added; iframe tag wrapped verbatim; cards keep props + guards. Pure view-state.
