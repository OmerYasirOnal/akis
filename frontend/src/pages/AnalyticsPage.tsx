import { useEffect, useState } from 'react'
import type { ApiClient, Analytics, SessionSummary } from '../api/client.js'
import { Card, SectionTitle, Stat } from '../ui/kit.js'
import { useI18n } from '../i18n/I18nContext.js'
import { agentName } from '../agents/names.js'
import { foldSessionView } from '../live/viewModel.js'
import { aggregateRunMetrics, type RunMetrics } from './runMetrics.js'
import { fmtTokens, fmtDuration } from '../chat/metricsFormat.js'

const pct = (n: number): string => `${Math.round(n * 100)}%`

/** The shared absent-value sentinel — identical in both locales, so no i18n key. */
const DASH = '—'

/** How many most-recent sessions the per-run aggregate fetches (N+1; bounded). */
const PER_RUN_LIMIT = 10

/** A run row for the per-run table: its summary + folded/aggregated metrics. */
interface RunRow { summary: SessionSummary; metrics: RunMetrics }

/** Run analytics dashboard — live aggregate stats from GET /api/analytics, plus a
 *  per-agent activity breakdown. Replaces the old bare form feel with a real dashboard. */
export function AnalyticsPage({ api }: { api: ApiClient }) {
  const { t } = useI18n()
  const [data, setData] = useState<Analytics | undefined>()
  const [loaded, setLoaded] = useState(false)
  const [runs, setRuns] = useState<RunRow[]>([])
  useEffect(() => { void api.getAnalytics().then(setData).catch(() => {}).finally(() => setLoaded(true)) }, [api])

  // Per-run cost: there is NO per-session token data in /api/analytics (it keeps no per-session
  // state by design), so aggregate IN THE FE from the same events the live badges fold. N+1
  // fetch (listMySessions + one getSessionLog per session), capped + Promise.allSettled so a
  // failed/evicted log degrades to '—' (never throws/hangs).
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const sessions = (await api.listMySessions()).slice(0, PER_RUN_LIMIT)
        const results = await Promise.allSettled(sessions.map(s => api.getSessionLog(s.id)))
        const rows: RunRow[] = sessions.map((summary, i) => {
          const r = results[i]
          const events = r && r.status === 'fulfilled' ? r.value.map(se => se.event) : []
          return { summary, metrics: aggregateRunMetrics(foldSessionView(summary.id, events)) }
        })
        if (!cancelled) setRuns(rows)
      } catch { /* no per-run section if history is unavailable — never crash the page */ }
    })()
    return () => { cancelled = true }
  }, [api])

  const empty = loaded && (!data || data.sessions === 0)
  const maxRuns = Math.max(1, ...(data?.agents ?? []).map(a => a.runs))

  return (
    <div className="flex flex-col gap-6">
      <SectionTitle sub={t('analytics.sub')}>{t('analytics.title')}</SectionTitle>

      {empty ? (
        <div className="grid min-h-[50vh] place-items-center">
          <Card className="grid place-items-center p-10 text-center text-slate-500">{t('analytics.empty')}</Card>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            <Stat label={t('analytics.sessions')} value={data?.sessions ?? '—'} accent />
            <Stat label={t('analytics.done')} value={data?.done ?? '—'} />
            <Stat label={t('analytics.verified')} value={data?.verifiedRuns ?? '—'} />
            <Stat label={t('analytics.passRate')} value={data ? pct(data.passRate) : '—'} accent />
            <Stat label={t('analytics.testsRun')} value={data?.testsRun ?? '—'} />
          </div>

          <Card className="p-5">
            <SectionTitle>{t('analytics.activity')}</SectionTitle>
            <div className="flex flex-col gap-3">
              {(data?.agents ?? []).length === 0 && <div className="text-sm text-slate-500">{t('analytics.empty')}</div>}
              {(data?.agents ?? []).map(a => (
                <div key={a.agent} className="flex items-center gap-3">
                  <div className="w-20 shrink-0 text-sm font-medium text-slate-200">{agentName(a.agent)}</div>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/5">
                    <div className="h-full rounded-full bg-gradient-to-r from-[#07D1AF] to-violet-500" style={{ width: `${(a.runs / maxRuns) * 100}%` }} />
                  </div>
                  <div className="w-24 shrink-0 text-right text-xs text-slate-400">{a.ok}/{a.runs} {t('analytics.ok')}</div>
                </div>
              ))}
            </div>
          </Card>

          {/* Per-run cost — Claude-Code-style "12.3k tok · 42s" per build, aggregated honestly
              from the SAME events the live badges show. Absent usage renders '—', never a 0. */}
          <Card className="p-5">
            <SectionTitle sub={t('analytics.perRun.sub')}>{t('analytics.perRun.title')}</SectionTitle>
            {runs.length === 0 ? (
              <div className="text-sm text-slate-500">{t('analytics.perRun.noData')}</div>
            ) : (
              <div className="flex flex-col divide-y divide-white/5">
                {runs.map(({ summary, metrics }) => (
                  <div key={summary.id} className="flex flex-col gap-1.5 py-3 first:pt-0 last:pb-0">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-200" title={summary.idea}>{summary.idea}</span>
                      <span className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${
                        summary.verified ? 'border-emerald-400/30 bg-emerald-400/[0.07] text-emerald-200' : 'border-white/10 bg-white/[0.02] text-slate-400'
                      }`}>{summary.status}</span>
                    </div>
                    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs text-slate-400 tabular-nums">
                      <span>{t('analytics.perRun.totalTokens')}: <span className="text-slate-200">{metrics.totalTokens !== undefined ? fmtTokens(metrics.totalTokens) : DASH}</span></span>
                      <span>{t('analytics.perRun.totalTime')}: <span className="text-slate-200">{fmtDuration(metrics.totalMs)}</span></span>
                    </div>
                    {metrics.perAgent.length > 0 && (
                      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10.5px] text-slate-500 tabular-nums">
                        {metrics.perAgent.map(a => (
                          <span key={a.role}>
                            <span className="text-slate-400">{agentName(a.role)}</span>{' '}
                            {a.tok !== undefined ? fmtTokens(a.tok) : DASH} · {a.tools} · {fmtDuration(a.ms)}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>

          {data?.provider && <div className="text-xs text-slate-500">{t('analytics.provider')}: <span className="text-slate-300">{data.provider}</span></div>}
        </>
      )}
    </div>
  )
}
