/**
 * DeviceFrame — wraps the preview iframe and sets its LOGICAL width per device preset.
 *
 * WHY: the preview panel needs to emulate different viewport widths without transform-scale
 * (we NEVER upscale a mobile/tablet preset — scaling up muddies text). The wrapper div is
 * mx-auto'd inside a dark letterbox so the iframe scrolls horizontally when smaller than the
 * pane (a wide preset on a narrow panel) while the rest of the panel vertically scrolls
 * independently.
 *
 * Width rules:
 *   responsive → 100%  (fills the pane)
 *   mobile     → 390px portrait / 844px landscape (iPhone logical 390×844)
 *   tablet     → 768px portrait / 1024px landscape (iPad logical 768×1024)
 *   desktop    → min(1280, paneWidth)px  (capped so the user sees the full width)
 *
 * Rotate (mobile/tablet only): swaps the preset's width↔height so the app's portrait/landscape
 * media queries fire authentically. We only set the iframe container's WIDTH — the iframe itself
 * (sandbox/allow/src) is never touched. Orientation is local state and RESETS to portrait when
 * the device changes (or moves to responsive/desktop, where rotate is meaningless).
 *
 * The device toggle row is ONLY shown when tab === 'preview' (M4 from plan).
 */
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n/I18nContext.js'

export type Device = 'responsive' | 'mobile' | 'tablet' | 'desktop' | 'custom'

/**
 * Canonical logical widths (PORTRAIT) per NAMED preset; null means "fill available" (responsive).
 * 'custom' is NOT here — it carries no canonical width; its width is the user-dragged value (state +
 * localStorage), clamped live to the pane via `clampCustomWidth`.
 */
export const DEVICE_WIDTHS: Record<Exclude<Device, 'custom'>, number | null> = {
  responsive: null,
  mobile: 390,
  tablet: 768,
  desktop: 1280,
}

// ── P2.4 Fluid drag-to-resize custom width ──────────────────────────────────────
// Meta-responsiveness: AKIS builds responsive apps, so the user must be able to check the GENERATED
// app at ARBITRARY breakpoints — not just the 4 canonical presets. The custom width drives the SAME
// logical-width mechanism (the frame container's CSS width); the iframe (src/sandbox/allow) is never
// touched, so resizing never reloads the running app.
export const CUSTOM_MIN_PX = 320            // a sane mobile floor — narrower than this isn't a real target
export const CUSTOM_MAX_PX = 1280           // the desktop ceiling; the LIVE cap is min(this, paneWidth)
export const CUSTOM_DEFAULT_PX = 768        // first-drag seed (a tablet-ish mid breakpoint)
export const CUSTOM_STEP_PX = 16            // keyboard Arrow step (8-pt grid)
export const CUSTOM_WIDTH_KEY = 'akis_preview_custom_width'

/**
 * Clamp a custom logical width to [CUSTOM_MIN_PX, min(CUSTOM_MAX_PX, paneWidth)].
 *
 * NARROW-PANE RULE: when the pane is narrower than the 320 floor (a tiny mobile bottom-sheet), the
 * FLOOR still wins — custom never collapses below a readable width; the dark letterbox simply scrolls
 * horizontally (same contract as a wide preset on a narrow pane). When the pane is roomy, the live cap
 * is the binding constraint so a custom width can never exceed the visible pane and force overflow.
 */
export function clampCustomWidth(px: number, paneWidth: number): number {
  const cap = Math.max(CUSTOM_MIN_PX, Math.min(CUSTOM_MAX_PX, Math.max(0, paneWidth) || CUSTOM_MAX_PX))
  return Math.round(Math.min(Math.max(px, CUSTOM_MIN_PX), cap))
}

/** Read the persisted custom width (survives a tab flip / reload). Falls back to the default on a
 *  missing/corrupt value or a private-mode store. */
export function loadCustomWidth(): number {
  try {
    const raw = localStorage.getItem(CUSTOM_WIDTH_KEY)
    const n = raw === null ? NaN : Number(raw)
    return Number.isFinite(n) ? n : CUSTOM_DEFAULT_PX
  } catch { return CUSTOM_DEFAULT_PX }
}
function saveCustomWidth(px: number): void {
  try { localStorage.setItem(CUSTOM_WIDTH_KEY, String(px)) } catch { /* ignore (private mode / quota) */ }
}

/**
 * Canonical logical heights (PORTRAIT) for the ROTATABLE presets only. Rotating to landscape
 * swaps width↔height, so the frame's logical width becomes this value. responsive/desktop never
 * rotate, so they have no entry here.
 */
export const DEVICE_HEIGHTS: Partial<Record<Device, number>> = {
  mobile: 844,
  tablet: 1024,
}

/** Presets that support rotate (a portrait/landscape swap is only meaningful for handhelds). */
const ROTATABLE: ReadonlySet<Device> = new Set<Device>(['mobile', 'tablet'])

/** The four NAMED presets shown in the toggle row. 'custom' is not a togglable button — it's the
 *  mode the fluid resize handle opts into, so it never appears here. */
const PRESETS: Exclude<Device, 'custom'>[] = ['responsive', 'mobile', 'tablet', 'desktop']

/** Glyph used in the toggle button face — Unicode box chars keep it font-independent. */
const GLYPH: Record<Exclude<Device, 'custom'>, string> = { responsive: '↔', mobile: '▢', tablet: '▯', desktop: '▭' }

export function DeviceFrame(
  { device, onDevice, paneWidth, tab, children }:
  { device: Device; onDevice: (d: Device) => void; paneWidth: number; tab: string; children: ReactNode },
) {
  const { t } = useI18n()

  // Orientation is view-state only. RESET to portrait whenever the device changes: a stale
  // landscape flag must never leak into a non-rotatable preset (responsive/desktop) or a fresh
  // preset selection. WHY effect (not derived): rotate is a user toggle, so it needs its own state.
  const [landscape, setLandscape] = useState(false)
  useEffect(() => { setLandscape(false) }, [device])

  const canRotate = ROTATABLE.has(device)
  // landscape only applies to rotatable presets; guard so a stale flag can't affect width math
  const isLandscape = canRotate && landscape

  // ── Custom width (P2.4) ──────────────────────────────────────────────────────
  // Seeded from localStorage so a custom breakpoint survives a tab flip / reload. The LIVE value is
  // always re-clamped against the current pane (a shrinking pane must never strand a stale width that
  // now overflows). The slider commits here AND persists; dragging also opts `device` into 'custom'.
  const [customWidth, setCustomWidth] = useState<number>(() => loadCustomWidth())
  // The live cap for both the slider's aria-valuemax and the re-clamp: min(1280, pane) floored at 320.
  const customCap = clampCustomWidth(CUSTOM_MAX_PX, paneWidth)
  // Re-clamp the stored custom width whenever the pane changes (mirrors useTreeResizable's re-clamp).
  // WHY guarded on paneWidth>0: jsdom / pre-measure reports 0 — don't collapse to the floor before a
  // real measurement arrives (the test passes an explicit paneWidth, so it always re-clamps there).
  useEffect(() => {
    if (paneWidth > 0) setCustomWidth(w => clampCustomWidth(w, paneWidth))
  }, [paneWidth])

  // The currently-displayed custom width (clamped to the live cap each render — covers the first frame
  // before the effect runs and a paneWidth=0 jsdom render).
  const customDisplay = clampCustomWidth(customWidth, paneWidth)

  const base: number | null = device === 'custom' ? customDisplay : DEVICE_WIDTHS[device]
  // The LOGICAL width that drives the frame:
  //   responsive → fill (null)
  //   custom     → the user-dragged width, clamped to the live cap
  //   desktop    → capped at the live pane (min(1280, paneWidth))
  //   mobile/tablet portrait  → preset width
  //   mobile/tablet landscape → preset height (the rotated long edge becomes the width)
  const logicalWidth: number | null =
    base === null
      ? null
      : device === 'custom'
      ? base
      : device === 'desktop'
      ? Math.min(base, Math.max(0, paneWidth))
      : isLandscape
      ? (DEVICE_HEIGHTS[device] ?? base)
      : base

  const widthStyle: string = logicalWidth === null ? '100%' : `${logicalWidth}px`

  // The slider's aria-valuenow reflects the ACTIVE logical width: a fixed-width preset shows its width,
  // 'custom' shows the dragged width, and responsive (fill) reports the live cap (its rendered max).
  const sliderNow = logicalWidth ?? customCap

  // Commit a new custom width: clamp → opt into custom mode (onDevice) → persist. The pointer-drag and
  // the keyboard handler both route through here so the clamp/persist/mode-switch is single-sourced.
  const commitCustom = useCallback((px: number) => {
    const next = clampCustomWidth(px, paneWidth)
    setCustomWidth(next)
    saveCustomWidth(next)
    if (device !== 'custom') onDevice('custom')
  }, [paneWidth, device, onDevice])

  // Keyboard resize parity with the splitters: Arrow steps ±16px (8-pt grid), Home/End jump to the
  // clamped min/max. The slider starts from the ACTIVE logical width (sliderNow) so a first Arrow on a
  // preset nudges off the preset into a custom width adjacent to it (no jarring jump).
  const onSliderKeyDown = useCallback((e: { key: string; preventDefault(): void }) => {
    if (e.key === 'Home') { e.preventDefault(); commitCustom(CUSTOM_MIN_PX); return }
    if (e.key === 'End') { e.preventDefault(); commitCustom(customCap); return }
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? +1
      : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0
    if (!dir) return
    e.preventDefault()
    commitCustom(sliderNow + dir * CUSTOM_STEP_PX)
  }, [commitCustom, customCap, sliderNow])

  // Pointer-drag the right-edge handle. We translate the pointer's clientX delta into a width delta off
  // the width AT GESTURE START (captured in dragRef) — so the gesture is absolute, not cumulative-laggy.
  // pointer-capture keeps the drag alive when the pointer leaves the thin handle. View-state only; no
  // gate/security surface — it sets the SAME container CSS width the presets do.
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)
  const onSliderPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    // Only the primary button / a touch contact starts a drag.
    if (e.button !== 0 && e.pointerType === 'mouse') return
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    dragRef.current = { startX: e.clientX, startW: sliderNow }
  }, [sliderNow])
  const onSliderPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d) return
    // The handle sits on the frame's RIGHT edge; dragging right widens. The frame is mx-auto-centered,
    // so a 1px pointer move grows the width by 2px (both edges move) — match that for a 1:1 feel.
    commitCustom(d.startW + (e.clientX - d.startX) * 2)
  }, [commitCustom])
  const endDrag = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    dragRef.current = null
    e.currentTarget.releasePointerCapture?.(e.pointerId)
  }, [])

  // WHY conditional helper: i18n map avoids a cascade of ternaries in JSX
  const labelFor = (d: Device): string =>
    d === 'responsive'
      ? t('preview.device.responsive')
      : d === 'mobile'
      ? t('preview.device.mobile')
      : d === 'tablet'
      ? t('preview.device.tablet')
      : t('preview.device.desktop')

  // Pixel readout: the ACTIVE logical width. For a fixed preset / custom it's the rendered width; for
  // responsive (fill) it's the live cap (the width the frame actually fills). Always live — it's the
  // slider's visible value, so it never reads stale during a drag.
  const displayPx = sliderNow

  return (
    <div className="flex h-full flex-col">
      {/* Toggle row — hidden when the active tab is not "preview" (M4).
          Gate/code tabs must not show the device selector to avoid layout jitter. */}
      {tab === 'preview' && (
        <div className="mb-2 flex items-center justify-end gap-2">
          <div
            role="group"
            aria-label={t('preview.device.label')}
            className="flex rounded-lg border border-white/10 bg-white/[0.03] p-0.5 text-xs"
          >
            {PRESETS.map(d => (
              <button
                key={d}
                type="button"
                aria-pressed={device === d}
                aria-label={labelFor(d)}
                onClick={() => onDevice(d)}
                // Smooth active/hover swap (the bg+text crossfade reads as a settled toggle, not a
                // hard cut); the tap-down scale is `motion-safe:` so reduced-motion keeps it instant.
                className={[
                  'rounded-md px-2 py-1 transition-colors motion-safe:active:scale-95',
                  device === d
                    ? 'bg-white/10 text-slate-100'
                    : 'text-slate-400 hover:text-slate-200',
                ].join(' ')}
              >
                {GLYPH[d]}
              </button>
            ))}
          </div>

          {/* Rotate — ONLY for rotatable presets (mobile/tablet). Hidden for responsive/desktop
              where portrait/landscape is meaningless. Swaps the preset width↔height in-place;
              icon-only to stay within the header row budget. */}
          {canRotate && (
            <button
              type="button"
              aria-pressed={isLandscape}
              aria-label={t('preview.rotate')}
              onClick={() => setLandscape(l => !l)}
              className={[
                'rounded-md border border-white/10 px-2 py-1 text-xs transition-colors motion-safe:active:scale-95',
                isLandscape
                  ? 'bg-white/10 text-slate-100'
                  : 'bg-white/[0.03] text-slate-400 hover:text-slate-200',
              ].join(' ')}
            >
              ⟳
            </button>
          )}

          {/* Pixel readout — the live ACTIVE logical width (the slider's visible value). Highlighted
              while in custom mode so the user knows the named presets are no longer driving the width.
              `custom`-tinted in teal; otherwise the quiet badge. */}
          <span
            className={[
              'rounded px-1.5 py-0.5 text-[10px] tabular-nums',
              device === 'custom' ? 'bg-teal-400/15 text-teal-200' : 'bg-white/[0.06] text-slate-400',
            ].join(' ')}
          >
            {device === 'custom' && <span className="mr-0.5" aria-hidden="true">↔</span>}
            {displayPx} {t('preview.device.unit')}
          </span>
        </div>
      )}

      {/* Dark letterbox container — owns the horizontal scroll so the chat pane is unaffected */}
      <div className="relative flex-1 overflow-auto bg-slate-950">
        <div
          data-testid="device-frame"
          // WIDTH MOTION (Task: polish): the logical width glides between presets and on rotate
          // (Responsive ↔ Mobil ↔ Tablet ↔ Masaüstü, portrait ↔ landscape) instead of snapping.
          // `motion-safe:` collapses it to an instant change under prefers-reduced-motion (a11y).
          // During a separator drag the drawer's ancestor carries `is-dragging`, and
          // `[.is-dragging_&]:!transition-none` KILLS the width transition so a Desktop-preset width
          // (capped at the live paneWidth) tracks the pointer 1:1 instead of lagging behind by the
          // 200ms ease — a smudgy drag would feel broken. We ALSO kill it while THIS frame is being
          // resize-dragged (`data-resizing`) so the custom width tracks the pointer 1:1.
          className="relative mx-auto h-full motion-safe:transition-[width] motion-safe:duration-200 motion-safe:ease-out [.is-dragging_&]:!transition-none data-[resizing=true]:!transition-none"
          style={{ width: widthStyle }}
          data-resizing={dragRef.current ? 'true' : undefined}
        >
          {children}

          {/* FLUID DRAG-TO-RESIZE HANDLE (P2.4) — a slider straddling the frame's RIGHT edge. Sets ONLY
              this container's CSS width (the same mechanism as the presets) → NO iframe src/sandbox
              change, no reload. The handle is anchored at `left-full` (the frame's right edge) with a
              negative half-width margin so the ≥44px touch target is CENTERED on the seam — the bulk of
              it spilling into the dark letterbox GUTTER, not overlaying the running app's clickable
              content (a full-width responsive frame has no gutter, so only the thin centered strip sits
              over the app edge — acceptable for the explicit resize affordance).
              `touch-action:none` lets a touch-drag own the gesture (no page scroll); `cursor-ew-resize`
              signals the affordance; the active/custom state is teal-tinted. Only mounts on the preview
              surface (the whole toggle row above is already gated on tab==='preview'). */}
          {tab === 'preview' && (
            <div
              role="slider"
              tabIndex={0}
              aria-label={t('preview.device.custom')}
              aria-orientation="horizontal"
              aria-valuemin={CUSTOM_MIN_PX}
              aria-valuemax={customCap}
              aria-valuenow={sliderNow}
              aria-valuetext={`${sliderNow} ${t('preview.device.unit')}`}
              onKeyDown={onSliderKeyDown}
              onPointerDown={onSliderPointerDown}
              onPointerMove={onSliderPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              title={t('preview.device.customHint')}
              // ≥44px hit area (w-11=2.75rem) CENTERED on the frame's right edge (left-full -ml-[1.375rem]
              // = half the width), so most of the target sits in the gutter. `touch-none` =
              // touch-action:none (the drag owns the gesture). Focus ring for keyboard.
              className="group absolute inset-y-0 left-full z-10 -ml-[1.375rem] flex w-11 cursor-ew-resize touch-none items-center justify-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-teal-400/60"
            >
              {/* The visible grip bar — quiet by default, teal in custom mode / on hover/focus. */}
              <span
                aria-hidden="true"
                className={[
                  'h-12 max-h-[40%] w-1 rounded-full transition-colors group-hover:bg-teal-300/80 group-focus-visible:bg-teal-300',
                  device === 'custom' ? 'bg-teal-300/80' : 'bg-white/20',
                ].join(' ')}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
