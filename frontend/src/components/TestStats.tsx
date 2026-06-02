import type { TestStats as Stats } from '../live/types.js'
import { useI18n } from '../i18n/I18nContext.js'

/** Verification / test stats. Shows `verify` results today; the Playwright/Cucumber
 *  fields (built/running/p95) render automatically once the preview/test-env backend
 *  populates them through the same TestStats shape (local-first vision). i18n + brand-teal. */
export function TestStats({ stats }: { stats: Stats }) {
  const { t } = useI18n()
  const cell = (label: string, value: string, tone = 'text-slate-100') => (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
      <div className="text-[10px] uppercase tracking-widest text-slate-400">{label}</div>
      <div className={`text-lg font-semibold ${tone}`}>{value}</div>
    </div>
  )
  if (!stats.ran) return <p className="text-sm text-slate-400">{t('tests.empty')}</p>
  return (
    <div className="grid grid-cols-4 gap-2">
      {cell(t('tests.run'), String(stats.testsRun), 'text-[#07D1AF]')}
      {cell(t('tests.result'), stats.passed ? t('tests.pass') : t('tests.fail'), stats.passed ? 'text-emerald-300' : 'text-rose-300')}
      {cell(t('tests.scenarios'), stats.scenariosBuilt !== undefined ? `${stats.scenariosRunning ?? 0}/${stats.scenariosBuilt}` : '—')}
      {cell(t('tests.p95'), stats.p95Ms !== undefined ? `${stats.p95Ms}ms` : '—')}
    </div>
  )
}
