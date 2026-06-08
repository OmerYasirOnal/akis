import type { TestEvidence } from '@akis/shared'
import type { TestStats as Stats } from '../live/types.js'
import { useI18n } from '../i18n/I18nContext.js'

/** Verification / test stats. Shows `verify` results today; the Playwright/Cucumber
 *  fields (built/running/p95) render automatically once the preview/test-env backend
 *  populates them through the same TestStats shape (local-first vision). i18n + brand-teal.
 *
 *  SCENARIO COUNT — `evidence` is the SAME structured TestEvidence the Trust Report renders
 *  its named scenarios from. The live `test_stats`/`test_progress` counters (`scenariosBuilt`)
 *  don't fire for a static-app boot-smoke run, so the strip used to read 'Scenarios —' even
 *  though the evidence DID list scenarios. We fall back to `evidence.scenarios.length` (the
 *  real count) so the row is visually complete WITHOUT inventing data — when neither source has
 *  scenarios, it honestly stays '—'. Pass-count is derived IDENTICALLY to the Trust Report
 *  (`scenarios.filter(s => s.passed).length`); this is PRESENTATION ONLY — never the gate truth.
 */
export function TestStats({ stats, evidence }: { stats: Stats; evidence?: TestEvidence | undefined }) {
  const { t } = useI18n()
  const cell = (label: string, value: string, tone = 'text-slate-100', title?: string) => (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2" {...(title ? { title } : {})}>
      <div className="text-[10px] uppercase tracking-widest text-slate-400">{label}</div>
      {/* Value settles its color in place as data arrives (no layout jump). Respects
          prefers-reduced-motion via motion-safe: — a reduced-motion user sees the value snap. */}
      <div className={`text-lg font-semibold motion-safe:transition-colors ${tone}`}>{value}</div>
    </div>
  )
  // Empty state renders the SAME 4-cell grid with '—' placeholders (review: a bare one-line
  // paragraph shoved the layout when results filled in). Stats now fill IN PLACE — no jump.
  const ran = stats.ran

  // Scenario count: prefer the live built/running counters; otherwise fall back to the
  // structured evidence the Trust Report already shows (`<passed>/<total>`). HONEST: absent
  // stays '—' when neither the live counters NOR the evidence carry any scenarios.
  const liveScenarios = ran && stats.scenariosBuilt !== undefined
    ? `${stats.scenariosRunning ?? 0}/${stats.scenariosBuilt}`
    : undefined
  const evidenceScenarios = evidence && evidence.scenarios.length > 0
    ? `${evidence.scenarios.filter(s => s.passed).length}/${evidence.scenarios.length}`
    : undefined
  const scenariosValue = liveScenarios ?? evidenceScenarios

  // p95 is GENUINELY absent today (TestEvidence carries only a summed durationMs, not a
  // percentile) — fabricating one would break HONESTY. Keep the cell ('—') so the row stays
  // visually complete, but add a tooltip so it reads as honest-absent, not broken.
  const p95Value = ran && stats.p95Ms !== undefined ? `${stats.p95Ms}ms` : undefined

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
      {/* Responsive (review): falls to 2×2 on a narrow panel instead of clipping the labels. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {cell(t('tests.run'), ran ? String(stats.testsRun) : '—', ran ? 'text-[#07D1AF]' : 'text-slate-500')}
        {cell(t('tests.result'), ran ? (stats.passed ? t('tests.pass') : t('tests.fail')) : '—', ran ? (stats.passed ? 'text-emerald-300' : 'text-rose-300') : 'text-slate-500')}
        {cell(t('tests.scenarios'), scenariosValue ?? '—', scenariosValue ? 'text-slate-100' : 'text-slate-500',
          scenariosValue ? undefined : t('tests.notMeasured'))}
        {cell(t('tests.p95'), p95Value ?? '—', p95Value ? 'text-slate-100' : 'text-slate-500',
          p95Value ? undefined : t('tests.notMeasured'))}
      </div>
    </div>
  )
}
