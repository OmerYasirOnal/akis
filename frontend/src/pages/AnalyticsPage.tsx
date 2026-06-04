import { useEffect, useState } from 'react'
import type { ApiClient, Analytics } from '../api/client.js'
import { Card, SectionTitle, Stat } from '../ui/kit.js'
import { useI18n } from '../i18n/I18nContext.js'
import { agentName } from '../agents/names.js'

const pct = (n: number): string => `${Math.round(n * 100)}%`

/** Run analytics dashboard — live aggregate stats from GET /api/analytics, plus a
 *  per-agent activity breakdown. Replaces the old bare form feel with a real dashboard. */
export function AnalyticsPage({ api }: { api: ApiClient }) {
  const { t } = useI18n()
  const [data, setData] = useState<Analytics | undefined>()
  const [loaded, setLoaded] = useState(false)
  useEffect(() => { void api.getAnalytics().then(setData).catch(() => {}).finally(() => setLoaded(true)) }, [api])

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
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
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
          {data?.provider && <div className="text-xs text-slate-500">{t('analytics.provider')}: <span className="text-slate-300">{data.provider}</span></div>}
        </>
      )}
    </div>
  )
}
