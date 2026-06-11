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
import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { useI18n } from '../i18n/I18nContext.js'

export type Device = 'responsive' | 'mobile' | 'tablet' | 'desktop'

/** Canonical logical widths (PORTRAIT) per preset; null means "fill available" (responsive). */
export const DEVICE_WIDTHS: Record<Device, number | null> = {
  responsive: null,
  mobile: 390,
  tablet: 768,
  desktop: 1280,
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

const PRESETS: Device[] = ['responsive', 'mobile', 'tablet', 'desktop']

/** Glyph used in the toggle button face — Unicode box chars keep it font-independent. */
const GLYPH: Record<Device, string> = { responsive: '↔', mobile: '▢', tablet: '▯', desktop: '▭' }

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

  const base = DEVICE_WIDTHS[device]
  // The LOGICAL width that drives the frame:
  //   responsive → fill (null)
  //   desktop    → capped at the live pane (min(1280, paneWidth))
  //   mobile/tablet portrait  → preset width
  //   mobile/tablet landscape → preset height (the rotated long edge becomes the width)
  const logicalWidth: number | null =
    base === null
      ? null
      : device === 'desktop'
      ? Math.min(base, Math.max(0, paneWidth))
      : isLandscape
      ? (DEVICE_HEIGHTS[device] ?? base)
      : base

  const widthStyle: string = logicalWidth === null ? '100%' : `${logicalWidth}px`

  // WHY conditional helper: i18n map avoids a cascade of ternaries in JSX
  const labelFor = (d: Device): string =>
    d === 'responsive'
      ? t('preview.device.responsive')
      : d === 'mobile'
      ? t('preview.device.mobile')
      : d === 'tablet'
      ? t('preview.device.tablet')
      : t('preview.device.desktop')

  // Pixel badge: show the current (possibly rotated) logical width for fixed-width presets only.
  const displayPx = logicalWidth !== null ? logicalWidth : null

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

          {/* Pixel badge — shown only for fixed-width presets */}
          {displayPx !== null && (
            <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] tabular-nums text-slate-400">
              {displayPx} {t('preview.device.unit')}
            </span>
          )}
        </div>
      )}

      {/* Dark letterbox container — owns the horizontal scroll so the chat pane is unaffected.
          CORNER CLIP (owner finding round-2 2026-06-11): the band wrapper (PreviewPanel) is
          `rounded-xl overflow-hidden`, but an iframe is a separate paint layer and ESCAPES an
          ancestor's corner clip across this `overflow-auto` scroll boundary — so a READY app's
          bottom corners rendered SQUARE against the band's rounded frame (verified in Brave: the
          iframe painted into the corner; rounding HERE clips it). This letterbox is the iframe's
          immediate scroll container, so its own `rounded-b-[11px]` (12px band radius − the band's
          1px border) is what actually clips the iframe to the frame. Bottom-only: the top edge sits
          under the browser-chrome strip, which already carries the band's top radius. */}
      <div className="relative flex-1 overflow-auto rounded-b-[11px] bg-slate-950">
        <div
          data-testid="device-frame"
          // WIDTH MOTION (Task: polish): the logical width glides between presets and on rotate
          // (Responsive ↔ Mobil ↔ Tablet ↔ Masaüstü, portrait ↔ landscape) instead of snapping.
          // `motion-safe:` collapses it to an instant change under prefers-reduced-motion (a11y).
          // During a separator drag the drawer's ancestor carries `is-dragging`, and
          // `[.is-dragging_&]:!transition-none` KILLS the width transition so a Desktop-preset width
          // (capped at the live paneWidth) tracks the pointer 1:1 instead of lagging behind by the
          // 200ms ease — a smudgy drag would feel broken.
          className="mx-auto h-full motion-safe:transition-[width] motion-safe:duration-200 motion-safe:ease-out [.is-dragging_&]:!transition-none"
          style={{ width: widthStyle }}
        >
          {children}
        </div>
      </div>
    </div>
  )
}
