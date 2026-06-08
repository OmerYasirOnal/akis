/**
 * DeviceFrame — wraps the preview iframe and sets its LOGICAL width per device preset.
 *
 * WHY: the preview panel needs to emulate different viewport widths without transform-scale
 * (v1 scope: no rotate, no tablet, no scale). The wrapper div is mx-auto'd inside a dark
 * letterbox so the iframe scrolls horizontally when smaller than the pane (desktop on a
 * narrow panel) while the rest of the panel vertically scrolls independently.
 *
 * Width rules (v1):
 *   responsive → 100%  (fills the pane)
 *   mobile     → 390px (iPhone logical width, hardcoded)
 *   desktop    → min(1280, paneWidth)px  (capped so the user sees the full width)
 *
 * The device toggle row is ONLY shown when tab === 'preview' (M4 from plan).
 */
import type { ReactNode } from 'react'
import { useI18n } from '../i18n/I18nContext.js'

export type Device = 'responsive' | 'mobile' | 'desktop'

/** Canonical logical widths per preset; null means "fill available" (responsive). */
export const DEVICE_WIDTHS: Record<Device, number | null> = {
  responsive: null,
  mobile: 390,
  desktop: 1280,
}

const PRESETS: Device[] = ['responsive', 'mobile', 'desktop']

/** Glyph used in the toggle button face — Unicode box chars keep it font-independent. */
const GLYPH: Record<Device, string> = { responsive: '↔', mobile: '▢', desktop: '▭' }

export function DeviceFrame(
  { device, onDevice, paneWidth, tab, children }:
  { device: Device; onDevice: (d: Device) => void; paneWidth: number; tab: string; children: ReactNode },
) {
  const { t } = useI18n()

  const base = DEVICE_WIDTHS[device]
  // desktop caps at paneWidth so horizontal overflow only appears when the preset is wider
  const widthStyle: string =
    base === null
      ? '100%'
      : `${device === 'desktop' ? Math.min(base, Math.max(0, paneWidth)) : base}px`

  // WHY conditional helper: i18n map avoids a cascade of ternaries in JSX
  const labelFor = (d: Device): string =>
    d === 'responsive'
      ? t('preview.device.responsive')
      : d === 'mobile'
      ? t('preview.device.mobile')
      : t('preview.device.desktop')

  // Show the pixel badge for fixed-width presets only (responsive fills its parent)
  const displayPx = base !== null ? base : null

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

          {/* Pixel badge — shown only for fixed-width presets */}
          {displayPx !== null && (
            <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] tabular-nums text-slate-400">
              {displayPx} {t('preview.device.unit')}
            </span>
          )}
        </div>
      )}

      {/* Dark letterbox container — owns the horizontal scroll so the chat pane is unaffected */}
      <div className="relative flex-1 overflow-auto bg-slate-950">
        <div
          data-testid="device-frame"
          // WIDTH MOTION (Task: polish): the logical width glides between presets
          // (Responsive ↔ Mobil ↔ Masaüstü) instead of snapping. `motion-safe:` collapses it to an
          // instant change under prefers-reduced-motion (a11y). During a separator drag the drawer's
          // ancestor carries `is-dragging`, and `[.is-dragging_&]:!transition-none` KILLS the width
          // transition so a Desktop-preset width (capped at the live paneWidth) tracks the pointer 1:1
          // instead of lagging behind by the 200ms ease — a smudgy drag would feel broken.
          className="mx-auto h-full motion-safe:transition-[width] motion-safe:duration-200 motion-safe:ease-out [.is-dragging_&]:!transition-none"
          style={{ width: widthStyle }}
        >
          {children}
        </div>
      </div>
    </div>
  )
}
