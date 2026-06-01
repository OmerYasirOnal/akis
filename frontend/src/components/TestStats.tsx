import type { TestStats as Stats } from '../live/types.js'

/** Verification / test stats. Shows `verify` results today; the Playwright/Cucumber
 *  fields (built/running/p95) render automatically once the preview/test-env backend
 *  populates them through the same TestStats shape (local-first vision). */
export function TestStats({ stats }: { stats: Stats }) {
  const cell = (label: string, value: string, tone = 'text-slate-200') => (
    <div className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
      <div className="text-[10px] uppercase tracking-widest text-slate-500">{label}</div>
      <div className={`text-lg font-semibold ${tone}`}>{value}</div>
    </div>
  )
  if (!stats.ran) return <p className="text-sm text-slate-500">No test run yet.</p>
  return (
    <div className="grid grid-cols-4 gap-2">
      {cell('Tests run', String(stats.testsRun))}
      {cell('Result', stats.passed ? 'PASS' : 'FAIL', stats.passed ? 'text-emerald-300' : 'text-rose-300')}
      {cell('Scenarios', stats.scenariosBuilt !== undefined ? `${stats.scenariosRunning ?? 0}/${stats.scenariosBuilt}` : '—')}
      {cell('p95', stats.p95Ms !== undefined ? `${stats.p95Ms}ms` : '—')}
    </div>
  )
}
