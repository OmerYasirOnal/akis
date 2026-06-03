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
    <div className="space-y-2">
      {/* P1-CORE-1: a simulated (mock-runner) verification is flagged AT THE RESULT, so a demo
          "✓ pass" can never be mistaken for a real ≥1-test pass. Absent on a live run. */}
      {stats.demo && (
        <span role="status" title={t('result.demo.title')}
          className="inline-flex items-center gap-1 rounded-md border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[11px] font-medium text-amber-200">
          <span aria-hidden>⚠</span>{t('result.demo.badge')}
        </span>
      )}
      <div className="grid grid-cols-4 gap-2">
        {cell(t('tests.run'), String(stats.testsRun), 'text-[#07D1AF]')}
        {cell(t('tests.result'), stats.passed ? t('tests.pass') : t('tests.fail'), stats.passed ? 'text-emerald-300' : 'text-rose-300')}
        {cell(t('tests.scenarios'), stats.scenariosBuilt !== undefined ? `${stats.scenariosRunning ?? 0}/${stats.scenariosBuilt}` : '—')}
        {cell(t('tests.p95'), stats.p95Ms !== undefined ? `${stats.p95Ms}ms` : '—')}
      </div>
    </div>
  )
}
