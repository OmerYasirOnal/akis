import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ApiClient, Analytics, SessionSummary } from '../api/client.js'
import { Card, SectionTitle, Stat } from '../ui/kit.js'
import { useI18n } from '../i18n/I18nContext.js'
import type { StringKey } from '../i18n/catalog.js'
import { agentName } from '../agents/names.js'
import { foldSessionView } from '../live/viewModel.js'
import type { SessionView } from '../live/types.js'
import {
  aggregateRunMetrics, aggregateModelUsage, aggregateAgentTotals, aggregateGrandTotals,
  cleanRunTitle, bucketRunsByTime, type RunMetrics, type Granularity, type TimeBucket,
} from './runMetrics.js'
import { fmtTokens, fmtDuration, fmtUsd } from '../chat/metricsFormat.js'

const pct = (n: number): string => `${Math.round(n * 100)}%`

/** The shared absent-value sentinel — identical in both locales, so no i18n key. */
const DASH = '—'

/** Friendly model label from a raw id — display polish only (falls back to the id):
 *  "claude-sonnet-4-6" → "Claude Sonnet 4.6"; "claude-haiku-4-5-20251001" → "Claude Haiku 4.5";
 *  "anthropic/claude-haiku-4.5" → "Claude Haiku 4.5". */
function friendlyModel(id: string): string {
  if (!id) return id
  const base = id.split('/').pop() ?? id
  const segs = base.split('-').filter(p => !/^\d{6,}$/.test(p)) // drop long date suffixes
  const words: string[] = []
  const nums: string[] = []
  for (const s of segs) {
    if (/^[\d.]+$/.test(s)) nums.push(s)
    else words.push(s.charAt(0).toUpperCase() + s.slice(1))
  }
  return (nums.length ? `${words.join(' ')} ${nums.join('.')}` : words.join(' ')).trim() || id
}

/** How many most-recent sessions the per-run aggregate fetches (N+1; bounded). */
const PER_RUN_LIMIT = 10

/** Chart colors per agent role — distinct, brand-aligned HEX (donut slices + bars need raw colors,
 *  not Tailwind gradient classes). Teal is the brand anchor (#07D1AF); the rest are spread across
 *  the wheel so a 4-slice donut is legible. A non-core/unknown role falls back to slate. */
const ROLE_COLOR: Record<string, string> = {
  orchestrator: '#07D1AF', // AKIS — brand teal
  scribe: '#38BDF8',       // sky-400
  proto: '#8B5CF6',        // violet-500
  trace: '#34D399',        // emerald-400
  critic: '#FBBF24',       // amber-400
}
const FALLBACK_COLOR = '#64748B' // slate-500 — non-core agents / unpriced model bucket
const roleColor = (role: string): string => ROLE_COLOR[role] ?? FALLBACK_COLOR

/** A run row for the per-run table: its summary + folded/aggregated metrics + start time.
 *  `startedAt` is the min event.ts across the run's events (epoch-ms), absent if the log was
 *  empty/evicted (the run then drops out of the time-series, never crashes it). */
interface RunRow { summary: SessionSummary; metrics: RunMetrics; startedAt?: number }

/** Run analytics dashboard — live aggregate stats from GET /api/analytics, plus a
 *  per-agent activity breakdown, a token-distribution donut, and a time-series chart. */
export function AnalyticsPage({ api }: { api: ApiClient }) {
  const { t, locale } = useI18n()
  const [data, setData] = useState<Analytics | undefined>()
  const [loaded, setLoaded] = useState(false)
  const [runs, setRuns] = useState<RunRow[]>([])
  // The SAME folded views the per-run rows are aggregated from — kept (not discarded) so the
  // report-wide rollups (by model / by agent / grand totals) read from one honest projection.
  const [views, setViews] = useState<SessionView[]>([])
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
        const folded: { summary: SessionSummary; view: SessionView; startedAt?: number }[] = sessions.map((summary, i) => {
          const r = results[i]
          const events = r && r.status === 'fulfilled' ? r.value.map(se => se.event) : []
          // Run start = the earliest backend-stamped ts across its events (epoch-ms); absent for an
          // empty/evicted log (then this run simply isn't placed in the time-series).
          const startedAt = events.length ? Math.min(...events.map(e => e.ts)) : undefined
          return { summary, view: foldSessionView(summary.id, events), ...(startedAt !== undefined ? { startedAt } : {}) }
        })
        const rows: RunRow[] = folded.map(({ summary, view, startedAt }) => ({
          summary, metrics: aggregateRunMetrics(view), ...(startedAt !== undefined ? { startedAt } : {}),
        }))
        if (!cancelled) {
          setRuns(rows)
          setViews(folded.map(f => f.view))
        }
      } catch { /* no per-run section if history is unavailable — never crash the page */ }
    })()
    return () => { cancelled = true }
  }, [api])

  const empty = loaded && (!data || data.sessions === 0)
  const maxRuns = Math.max(1, ...(data?.agents ?? []).map(a => a.runs))

  // Report-wide rollups, derived once per views change (the heavy fold already ran in the effect).
  const modelUsage = useMemo(() => aggregateModelUsage(views), [views])
  const agentTotals = useMemo(() => aggregateAgentTotals(views), [views])
  const grand = useMemo(() => aggregateGrandTotals(views), [views])
  // Bar denominators: the leading row is full-width; absent → 1 so the math never divides by 0.
  const maxAgentTok = Math.max(1, ...agentTotals.map(a => a.tokens))

  // Time-series: the timed runs (those whose log had a startedAt) feed the bucketer. `now` is read
  // once per render — fine for a static dashboard (no live ticking needed).
  const timedRuns = useMemo(
    () => runs.flatMap(r => (r.startedAt !== undefined ? [{ startedAt: r.startedAt, tokens: r.metrics.totalTokens ?? 0 }] : [])),
    [runs],
  )

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

          {/* Report-wide total usage — the headline "how much did all my builds cost" tiles.
              Aggregated from the SAME folded views as the per-run rows, so they reconcile. */}
          <div>
            <SectionTitle>{t('analytics.totals.title')}</SectionTitle>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Stat label={t('analytics.totals.tokens')} value={grand.tokens !== undefined ? fmtTokens(grand.tokens) : DASH} accent />
              <Stat label={t('analytics.totals.cost')} value={grand.usd !== undefined ? fmtUsd(grand.usd) : DASH} />
              <Stat label={t('analytics.totals.time')} value={fmtDuration(grand.ms)} />
            </div>
          </div>

          {/* Token DISTRIBUTION — the graphical centerpiece: a by-agent donut (the most slices,
              real Proto/Trace/Critic/Scribe data) beside a legend, plus a compact by-model donut.
              The bar lists are folded INTO each donut's legend so no data is lost. */}
          <Card className="p-5">
            <SectionTitle sub={t('analytics.dist.sub')}>{t('analytics.dist.title')}</SectionTitle>
            {agentTotals.length === 0 && modelUsage.length === 0 ? (
              <div className="text-sm text-slate-500">{t('analytics.dist.noData')}</div>
            ) : (
              <div className="grid gap-8 lg:grid-cols-2">
                {/* Primary: by-agent (multi-slice). */}
                <div className="flex flex-col gap-2">
                  <div className="text-xs font-medium uppercase tracking-wide text-slate-400">{t('analytics.dist.byAgent')}</div>
                  <Donut
                    slices={agentTotals.map(a => ({ key: a.role, label: agentName(a.role), value: a.tokens, color: roleColor(a.role) }))}
                    totalLabel={t('analytics.dist.total')}
                    renderMeta={a => {
                      const tot = agentTotals.find(x => x.role === a.key)
                      return tot ? <>{fmtTokens(tot.tokens)}{tot.usd !== undefined ? ` · ${fmtUsd(tot.usd)}` : ''}</> : null
                    }}
                  />
                </div>
                {/* Secondary: by-model (often 1–2 slices, still a clean ring). */}
                <div className="flex flex-col gap-2">
                  <div className="text-xs font-medium uppercase tracking-wide text-slate-400">{t('analytics.dist.byModel')}</div>
                  <Donut
                    slices={modelUsage.map((m, i) => ({ key: m.model || DASH, label: m.model ? friendlyModel(m.model) : DASH, value: m.tokens, color: MODEL_PALETTE[i % MODEL_PALETTE.length]! }))}
                    totalLabel={t('analytics.dist.total')}
                    renderMeta={s => {
                      const mu = modelUsage.find(x => (x.model || DASH) === s.key)
                      return mu ? <>{fmtTokens(mu.tokens)}{mu.usd !== undefined ? ` · ${fmtUsd(mu.usd)}` : ''} · {mu.calls} {t('analytics.byModel.calls')}</> : null
                    }}
                  />
                </div>
              </div>
            )}
          </Card>

          {/* Usage OVER TIME — a real bucketed series with a granularity toggle. Honest note: with
              sparse data (often a single day) most buckets render as faint zero bars; the chart
              fills in as more builds land across days/weeks. */}
          <TimeSeriesCard runs={timedRuns} locale={locale} />

          {/* Tokens PER AGENT — each role's total token cost across all builds, proportional bar.
              Kept as the explicit ranked breakdown beneath the donut. */}
          <Card className="p-5">
            <SectionTitle sub={t('analytics.byAgent.sub')}>{t('analytics.byAgent.title')}</SectionTitle>
            {agentTotals.length === 0 ? (
              <div className="text-sm text-slate-500">{t('analytics.perRun.noData')}</div>
            ) : (
              <div className="flex flex-col gap-3">
                {agentTotals.map(a => (
                  <div key={a.role} className="flex items-center gap-3">
                    <div className="flex w-24 shrink-0 items-center gap-2 text-sm font-medium text-slate-200">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: roleColor(a.role) }} aria-hidden />
                      {agentName(a.role)}
                    </div>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/5">
                      <div className="h-full rounded-full" style={{ width: `${(a.tokens / maxAgentTok) * 100}%`, background: roleColor(a.role) }} />
                    </div>
                    <div className="w-32 shrink-0 text-right text-xs text-slate-400 tabular-nums">
                      <span className="text-slate-200">{fmtTokens(a.tokens)}</span> · {a.usd !== undefined ? fmtUsd(a.usd) : DASH}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

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
                {runs.map(({ summary, metrics }) => {
                  // Spec ideas are stored as Markdown ("# Title\n## Scope …"); show the clean human
                  // title, but keep the FULL idea as the hover tooltip.
                  const title = cleanRunTitle(summary.idea) || summary.idea
                  return (
                    <div key={summary.id} className="flex flex-col gap-1.5 py-3 first:pt-0 last:pb-0">
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-200" title={summary.idea}>{title}</span>
                        <span className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${
                          summary.verified ? 'border-emerald-400/30 bg-emerald-400/[0.07] text-emerald-200' : 'border-white/10 bg-white/[0.02] text-slate-400'
                        }`}>{summary.status}</span>
                      </div>
                      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs text-slate-400 tabular-nums">
                        <span>{t('analytics.perRun.totalTokens')}: <span className="text-slate-200">{metrics.totalTokens !== undefined ? fmtTokens(metrics.totalTokens) : DASH}</span></span>
                        <span>{t('analytics.perRun.estCost')}: <span className="text-slate-200">{metrics.totalUsd !== undefined ? fmtUsd(metrics.totalUsd) : DASH}</span></span>
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
                  )
                })}
              </div>
            )}
          </Card>

          {data?.provider && <div className="text-xs text-slate-500">{t('analytics.provider')}: <span className="text-slate-300">{data.provider}</span></div>}
        </>
      )}
    </div>
  )
}

/** Distinct colors for the by-model donut (models are arbitrary strings, no fixed role color). */
const MODEL_PALETTE = ['#07D1AF', '#8B5CF6', '#38BDF8', '#FBBF24', '#34D399', '#F472B6', '#64748B']

interface DonutSlice { key: string; label: string; value: number; color: string }

/**
 * Inline-SVG donut: stacked stroke-dasharray arcs on a single ring, with a center total and a
 * legend (swatch + label + share% + caller-rendered meta). No chart deps. Slices with value 0 are
 * dropped (no zero-width arc). When everything is 0/empty it renders a faint placeholder ring.
 */
function Donut({ slices, totalLabel, renderMeta }: {
  slices: DonutSlice[]
  totalLabel: string
  renderMeta?: (s: DonutSlice) => ReactNode
}) {
  const drawn = slices.filter(s => s.value > 0)
  const total = drawn.reduce((sum, s) => sum + s.value, 0)
  // SVG ring geometry: r=60 → circumference ≈ 377; we lay arcs end-to-end via dashoffset.
  const R = 60
  const C = 2 * Math.PI * R
  let acc = 0
  return (
    <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-center">
      <svg viewBox="0 0 160 160" className="h-40 w-40 shrink-0 -rotate-90" role="img" aria-label={totalLabel}>
        {/* track */}
        <circle cx="80" cy="80" r={R} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="16" />
        {total === 0
          ? null
          : drawn.map(s => {
              const frac = s.value / total
              const dash = frac * C
              const seg = (
                <circle
                  key={s.key} cx="80" cy="80" r={R} fill="none" stroke={s.color} strokeWidth="16"
                  strokeDasharray={`${dash} ${C - dash}`} strokeDashoffset={-acc * C}
                  strokeLinecap="butt"
                >
                  <title>{`${s.label}: ${Math.round(frac * 100)}%`}</title>
                </circle>
              )
              acc += frac
              return seg
            })}
        {/* center total (counter-rotated back to upright via the parent's -rotate-90) */}
        <g className="rotate-90" style={{ transformOrigin: '80px 80px' }}>
          <text x="80" y="74" textAnchor="middle" className="fill-slate-100 text-[15px] font-bold tabular-nums">{fmtTokens(total)}</text>
          <text x="80" y="92" textAnchor="middle" className="fill-slate-500 text-[8px] uppercase tracking-wide">{totalLabel}</text>
        </g>
      </svg>
      <ul className="flex min-w-0 flex-1 flex-col gap-1.5">
        {(drawn.length ? drawn : slices).map(s => {
          const share = total > 0 ? s.value / total : 0
          return (
            <li key={s.key} className="flex items-center gap-2 text-xs">
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: s.color }} aria-hidden />
              <span className="min-w-0 flex-1 truncate text-slate-200" title={s.label}>{s.label}</span>
              <span className="shrink-0 tabular-nums text-slate-400">
                {renderMeta?.(s)} <span className="ml-1 text-slate-500">{Math.round(share * 100)}%</span>
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

const GRANULARITIES: { id: Granularity; key: StringKey }[] = [
  { id: 'daily', key: 'analytics.time.daily' },
  { id: 'weekly', key: 'analytics.time.weekly' },
  { id: 'monthly', key: 'analytics.time.monthly' },
  { id: 'yearly', key: 'analytics.time.yearly' },
]

/**
 * Time-series card: a segmented Daily/Weekly/Monthly/Yearly control over a bucketed token-by-period
 * bar chart. The bucketer windows a fixed recent span ending "now", so empty periods render as
 * faint zero bars and the chart reads as a real series even with one day of data (honest: data IS
 * sparse today — see bucketRunsByTime's doc). `now` is captured once per granularity change.
 */
function TimeSeriesCard({ runs, locale }: { runs: { startedAt: number; tokens: number }[]; locale: string }) {
  const { t } = useI18n()
  const [granularity, setGranularity] = useState<Granularity>('daily')
  const buckets = useMemo<TimeBucket[]>(
    () => bucketRunsByTime(runs, granularity, Date.now(), undefined, locale),
    [runs, granularity, locale],
  )
  const maxTok = Math.max(1, ...buckets.map(b => b.tokens))
  const hasAny = buckets.some(b => b.runs > 0)

  return (
    <Card className="p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <SectionTitle sub={t('analytics.time.sub')}>{t('analytics.time.title')}</SectionTitle>
        <div className="flex rounded-lg border border-white/10 bg-white/[0.02] p-0.5 text-xs">
          {GRANULARITIES.map(g => (
            <button
              key={g.id} type="button" onClick={() => setGranularity(g.id)}
              aria-pressed={granularity === g.id}
              className={`rounded-md px-2.5 py-1 font-medium transition ${
                granularity === g.id ? 'bg-gradient-to-r from-[#07D1AF] to-violet-500 text-slate-950' : 'text-slate-400 hover:text-slate-200'
              }`}
            >{t(g.key)}</button>
          ))}
        </div>
      </div>

      {/* The bar row: flex columns, each a bar (height ∝ tokens) over its bucket label. An empty
          bucket draws a faint minimal stub so the axis stays readable; a filled bucket uses the
          accent gradient. Hover/title shows tokens + run count. */}
      <div className="flex items-end gap-2 sm:gap-3" style={{ height: 168 }}>
        {buckets.map(b => {
          const heightPct = b.tokens > 0 ? Math.max(6, (b.tokens / maxTok) * 100) : 2 // empty → faint stub
          const filled = b.runs > 0
          const runWord = b.runs === 1 ? t('analytics.time.run') : t('analytics.time.runs')
          return (
            <div key={b.key} className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1.5" style={{ height: '100%' }}>
              <div className="flex w-full flex-1 items-end">
                <div
                  className={`w-full rounded-t-md transition-all ${filled ? 'bg-gradient-to-t from-[#07D1AF] to-violet-500 shadow-[0_0_18px_rgba(7,209,175,0.25)]' : 'bg-white/[0.06]'}`}
                  style={{ height: `${heightPct}%` }}
                  title={`${b.label} · ${fmtTokens(b.tokens)} ${t('analytics.time.tokens')} · ${b.runs} ${runWord}`}
                />
              </div>
              <div className="w-full truncate text-center text-[10px] text-slate-500" title={b.label}>{b.label}</div>
            </div>
          )
        })}
      </div>

      {!hasAny && <div className="mt-3 text-xs text-slate-500">{t('analytics.time.sparse')}</div>}
    </Card>
  )
}
