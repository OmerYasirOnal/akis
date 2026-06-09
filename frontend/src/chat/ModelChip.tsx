import { useI18n } from '../i18n/I18nContext.js'
import type { StringKey } from '../i18n/catalog.js'

export type Effort = 'fast' | 'balanced' | 'deep'

export interface ModelChipProps {
  /** Model DISPLAY label (e.g. "Claude Sonnet 4.6"). */
  model: string
  effort: Effort
  /** Whether the popover it opens is currently open — drives aria-expanded (the chip is the
   *  popover trigger now, not a standalone modal opener). */
  open?: boolean
  /** id of the popover this chip controls (aria-controls), set when the popover is open. */
  controls?: string
  onClick?: () => void
}

/**
 * A compact, tappable chip INSIDE the composer toolbar that makes the active model VISIBLE
 * ("neyle çalışıyoruz görünsün"): provider · model · effort. Tapping it opens the in-composer
 * <ModelPicker> popover (this chip is its anchored trigger). Read-only presentation — it holds no
 * state; the parent owns the selection.
 *
 * DROPPED (P1.3): the LIVE/DEMO/"no key" status pill. The composer is now the ONE surface and the
 * "CANLI" badge added noise without action; the no-key signal lives INSIDE the picker per-provider
 * (where it is actionable), so the chip stays a quiet, single-purpose trigger with a ▾ caret.
 */
export function ModelChip({ model, effort, open, controls, onClick }: ModelChipProps) {
  const { t } = useI18n()
  // Effort label key is a known fixed set — cast the template key to StringKey (the catalog
  // has all three `chat.picker.effort.{fast,balanced,deep}` entries in both locales).
  const effortLabel = t(`chat.picker.effort.${effort}` as StringKey)
  return (
    <button
      type="button"
      onClick={onClick}
      aria-haspopup="dialog"
      aria-expanded={open ?? false}
      {...(open && controls ? { 'aria-controls': controls } : {})}
      aria-label={t('chat.chip.label')}
      title={t('chat.chip.label')}
      className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-xs text-slate-200 transition hover:border-white/25 hover:bg-white/[0.06]"
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#07D1AF]" aria-hidden="true" />
      <span className="truncate font-semibold text-slate-100">{model}</span>
      <span className="text-slate-500" aria-hidden="true">·</span>
      <span className="shrink-0 text-slate-400">{effortLabel}</span>
      <span className="shrink-0 text-slate-500" aria-hidden="true">▾</span>
    </button>
  )
}
