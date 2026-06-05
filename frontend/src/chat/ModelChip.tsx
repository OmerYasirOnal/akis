import { useI18n } from '../i18n/I18nContext.js'
import type { StringKey } from '../i18n/catalog.js'

export type Effort = 'fast' | 'balanced' | 'deep'

export interface ModelChipProps {
  /** Provider DISPLAY label (e.g. "Anthropic (Claude)"). */
  provider: string
  /** Model DISPLAY label (e.g. "Claude Sonnet 4.6"). */
  model: string
  effort: Effort
  /** Serving mode from /health — surfaces a DEMO badge so fake-verification is never hidden. */
  mode: 'live' | 'demo'
  onClick?: () => void
}

/**
 * A compact, tappable chip near the chat composer that makes the active model VISIBLE
 * ("neyle çalışıyoruz görünsün"): provider · model · effort, plus a LIVE/DEMO badge.
 * Tapping it opens the <ModelPicker>. Read-only presentation — it holds no state; the
 * parent owns the selection and the mode (read once from /health).
 */
export function ModelChip({ provider, model, effort, mode, onClick }: ModelChipProps) {
  const { t } = useI18n()
  // Effort label key is a known fixed set — cast the template key to StringKey (the catalog
  // has all three `chat.picker.effort.{fast,balanced,deep}` entries in both locales).
  const effortLabel = t(`chat.picker.effort.${effort}` as StringKey)
  const demo = mode === 'demo'
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t('chat.chip.label')}
      title={t('chat.chip.label')}
      className="inline-flex max-w-full items-center gap-2 self-start rounded-full border border-[#07D1AF]/30 bg-[#07D1AF]/[0.08] px-3 py-1.5 text-xs text-teal-100 transition hover:border-[#07D1AF]/60 hover:bg-[#07D1AF]/[0.14]"
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#07D1AF]" aria-hidden="true" />
      <span className="truncate font-semibold">{provider}</span>
      <span className="text-teal-400/60" aria-hidden="true">·</span>
      <span className="truncate">{model}</span>
      <span className="text-teal-400/60" aria-hidden="true">·</span>
      <span className="shrink-0">{effortLabel}</span>
      <span
        className={
          'ml-1 shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold tracking-wide ' +
          (demo ? 'bg-amber-400/20 text-amber-200' : 'bg-emerald-400/20 text-emerald-200')
        }
      >
        {demo ? t('chat.chip.demo') : t('chat.chip.live')}
      </span>
    </button>
  )
}
