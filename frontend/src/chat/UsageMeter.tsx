import { type ReactNode } from 'react'
import type { UsageInfo } from '../api/client.js'
import { useI18n } from '../i18n/I18nContext.js'

/** Compact formatting that keeps small numbers exact and only abbreviates at 10k+ (15300 →
 *  "15k") so the meter stays small without an odd "1.0k" for round thousands. */
function compact(n: number): string {
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  return String(n)
}

/**
 * A small per-user token-usage indicator beside the model chip. Shows `used / budget` and the
 * remaining headroom; "unlimited" when `budget:0` (single-operator dev) — though in that case
 * the parent simply hides it (no clutter when there is no real limit). Returns null when there
 * is no usage to show (call 401'd / unlimited). Read-only, no gate authority.
 */
export function UsageMeter({ usage }: { usage: UsageInfo | null }): ReactNode {
  const { t } = useI18n()
  if (!usage) return null
  const unlimited = usage.budget <= 0 || usage.remaining < 0
  // Hide entirely when unlimited — there is nothing to meter for single-operator dev.
  if (unlimited) return null
  const exceeded = usage.remaining === 0
  return (
    <div
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${
        exceeded ? 'border-rose-400/40 bg-rose-500/10 text-rose-200' : 'border-white/10 bg-white/[0.04] text-slate-300'
      }`}
      title={usage.resetAt ? `${t('usage.resets')}: ${new Date(usage.resetAt).toLocaleString()}` : undefined}
      aria-label={`${t('usage.label')}: ${usage.usedTokens} / ${usage.budget}`}
    >
      <span className="uppercase tracking-wide text-[10px] text-slate-400">{t('usage.label')}</span>
      <span>{compact(usage.usedTokens)} / {compact(usage.budget)}</span>
      {exceeded
        ? <span className="text-rose-300">{t('usage.exceeded')}</span>
        : <span className="text-slate-400">{compact(usage.remaining)} {t('usage.remaining')}</span>}
    </div>
  )
}
