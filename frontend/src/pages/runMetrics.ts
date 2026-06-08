import type { Role } from '@akis/shared'
import { estimateCostUsd } from '@akis/shared'
import type { SessionView } from '../live/types.js'

/**
 * Turn a raw run `idea` (often a saved spec, e.g. "# Modern Not Alma Uygulaması\n## Kapsam …")
 * into a clean one-line title for the per-run list — PURE, so it is unit-tested. The stored idea
 * can be full Markdown; the list wants the human title, not literal '#'/'**'/backtick markers.
 *  - take the FIRST non-empty, non-code-fence line (a leading heading is the title);
 *  - strip leading heading marks (`^#{1,6}\s*`), surrounding bold/italic/backtick markers, and a
 *    trailing colon;
 *  - collapse inner whitespace and trim.
 * Returns '' only for an all-blank/empty idea (the caller then falls back to the raw idea/tooltip). */
export function cleanRunTitle(idea: string): string {
  const lines = idea.split('\n')
  let line = ''
  let inFence = false // track fenced blocks so code inside never surfaces as the title
  for (const raw of lines) {
    const candidate = raw.trim()
    if (candidate.startsWith('```') || candidate.startsWith('~~~')) { inFence = !inFence; continue } // fence toggle
    if (inFence || !candidate) continue // skip fenced content + blank lines
    line = candidate
    break
  }
  return line
    .replace(/^#{1,6}\s*/, '')           // leading markdown heading marks
    .replace(/^[*_~`]+/, '')             // leading bold/italic/strike/code markers
    .replace(/[*_~`]+$/, '')             // trailing emphasis/code markers
    .replace(/:\s*$/, '')                // a dangling "Title:" colon
    .replace(/\s+/g, ' ')                // collapse inner whitespace
    .trim()
}

/** One agent's aggregated cost for a run (latest metrics that agent reported). `tok` is
 *  ABSENT when the agent reported no real usage (→ the UI dashes), never a fabricated 0. `usd` is the
 *  ESTIMATED cost (priced from the model + tokens), ABSENT when the model is unknown/unpriced. */
export interface AgentRunMetric {
  role: Role
  tok?: number
  usd?: number
  tools: number
  ms: number
}

/** A whole run's aggregated cost. `totalTokens` is UNDEFINED when NO agent reported usage
 *  (so the UI shows '—'), distinct from a real summed value (possibly small). `totalUsd` is the
 *  ESTIMATED total cost, UNDEFINED when no usage could be priced (unknown models). */
export interface RunMetrics {
  totalTokens?: number
  totalUsd?: number
  totalMs: number
  perAgent: AgentRunMetric[]
}

/**
 * Aggregate per-run cost from a folded SessionView — PURE, so it is unit-tested and reused by
 * the analytics table. Reads the SAME metrics the live badges show (step.metrics), so the
 * aggregate is honest by construction.
 *
 * - totalTokens sums (inTokens+outTokens) across every step that REPORTED usage; it stays
 *   UNDEFINED when NO step reported any (the honest '—'). A {0,0}-only run (mock) never carries
 *   usage at all (the builder collapsed it), so it naturally dashes — the honesty rule holds
 *   end to end.
 * - totalMs sums every step's durationMs (always real).
 * - perAgent lists each role once with its LATEST metrics (last step on any lane).
 */
export function aggregateRunMetrics(view: SessionView): RunMetrics {
  // role → its latest metric (last across all lanes/steps, in fold order).
  const latest = new Map<Role, { tok?: number; usd?: number; tools: number; ms: number }>()
  let totalTokens: number | undefined
  let totalUsd: number | undefined
  let totalMs = 0

  for (const lane of view.lanes) {
    for (const step of lane.steps) {
      const m = step.metrics
      if (!m) continue
      const ms = m.durationMs ?? 0
      totalMs += ms
      const tok = m.usage ? m.usage.inTokens + m.usage.outTokens : undefined
      if (tok !== undefined) totalTokens = (totalTokens ?? 0) + tok
      // ESTIMATED cost (priced from the agent's model + tokens). Only a KNOWN (priced) model
      // contributes — an unknown model leaves usd absent (the UI dashes), never a fabricated $0.
      const cost = m.usage ? estimateCostUsd(m.model, m.usage.inTokens, m.usage.outTokens) : undefined
      const usd = cost?.known ? cost.usd : undefined
      if (usd !== undefined) totalUsd = (totalUsd ?? 0) + usd
      // ACCUMULATE per agent (Opus review MED): an iterate loop reruns Proto, and the
      // breakdown must reconcile with the totals — a row shows that agent's TRUE cost
      // including retries, so sum(perAgent) === total by construction.
      const prev = latest.get(step.agent)
      latest.set(step.agent, {
        ...(tok !== undefined || prev?.tok !== undefined ? { tok: (prev?.tok ?? 0) + (tok ?? 0) } : {}),
        ...(usd !== undefined || prev?.usd !== undefined ? { usd: (prev?.usd ?? 0) + (usd ?? 0) } : {}),
        tools: (prev?.tools ?? 0) + (m.toolCalls ?? 0),
        ms: (prev?.ms ?? 0) + ms,
      })
    }
  }

  const perAgent: AgentRunMetric[] = [...latest.entries()].map(([role, v]) => ({
    role,
    ...(v.tok !== undefined ? { tok: v.tok } : {}),
    ...(v.usd !== undefined ? { usd: v.usd } : {}),
    tools: v.tools,
    ms: v.ms,
  }))

  return { ...(totalTokens !== undefined ? { totalTokens } : {}), ...(totalUsd !== undefined ? { totalUsd } : {}), totalMs, perAgent }
}

/** One model's aggregated spend ACROSS all the views in the report. `usd` is the ESTIMATED cost,
 *  ABSENT when none of this model's steps could be priced (unknown/unlisted model) — never a $0.
 *  `calls` counts the usage-bearing steps (the only steps that contribute), so a model that ran
 *  but reported no usage never appears (we never fabricate a 0-token row). */
export interface ModelUsage {
  model: string
  tokens: number
  usd?: number
  calls: number
}

/**
 * Aggregate token spend PER MODEL across the whole report — PURE, so it is unit-tested and reused
 * by the analytics "by model" card. Same honesty rule as aggregateRunMetrics: a step contributes
 * ONLY when `metrics.usage` is present (an LLM-free agent or a {0,0} mock never carries usage, so it
 * is skipped — never a fabricated 0). `usd` accrues only from a KNOWN (priced) model+usage pair, so a
 * model with usage we can't price keeps `usd` absent (the UI dashes), never an invented $0.
 * Sorted desc by tokens so the biggest spender leads the card.
 */
export function aggregateModelUsage(views: SessionView[]): ModelUsage[] {
  // model → its running totals; usd is undefined until at least one priced step contributes.
  const byModel = new Map<string, { tokens: number; usd?: number; calls: number }>()
  for (const view of views) {
    for (const lane of view.lanes) {
      for (const step of lane.steps) {
        const m = step.metrics
        if (!m?.usage) continue // honesty: only usage-bearing steps count, never an invented 0
        const key = m.model ?? '' // group unpriced/absent-model steps under one bucket (still real tokens)
        const tok = m.usage.inTokens + m.usage.outTokens
        const cost = estimateCostUsd(m.model, m.usage.inTokens, m.usage.outTokens)
        const usd = cost.known ? cost.usd : undefined
        const prev = byModel.get(key)
        byModel.set(key, {
          tokens: (prev?.tokens ?? 0) + tok,
          ...(usd !== undefined || prev?.usd !== undefined ? { usd: (prev?.usd ?? 0) + (usd ?? 0) } : {}),
          calls: (prev?.calls ?? 0) + 1,
        })
      }
    }
  }
  return [...byModel.entries()]
    .map(([model, v]) => ({ model, tokens: v.tokens, ...(v.usd !== undefined ? { usd: v.usd } : {}), calls: v.calls }))
    .sort((a, b) => b.tokens - a.tokens)
}

/** One agent role's aggregated spend ACROSS all the views. `usd` ABSENT when none of this role's
 *  steps could be priced (never a $0). `runs` counts the DISTINCT views in which this role reported
 *  any usage (so a role that ran LLM-free everywhere never appears). */
export interface AgentTotal {
  role: Role
  tokens: number
  usd?: number
  runs: number
}

/**
 * Aggregate token spend PER AGENT ROLE across the whole report — PURE, reused by the "per agent"
 * card. Same honesty rule: only `metrics.usage` steps contribute their tokens/usd; `runs` is the
 * count of DISTINCT views in which the role had ≥1 usage-bearing step (so the row reads "spent X
 * across N builds"). Sorted desc by tokens.
 */
export function aggregateAgentTotals(views: SessionView[]): AgentTotal[] {
  // role → running totals + the set of view ids it spent tokens in (for the distinct-runs count).
  const byRole = new Map<Role, { tokens: number; usd?: number; viewIds: Set<string> }>()
  for (const view of views) {
    for (const lane of view.lanes) {
      for (const step of lane.steps) {
        const m = step.metrics
        if (!m?.usage) continue // honesty: only usage-bearing steps count
        const tok = m.usage.inTokens + m.usage.outTokens
        const cost = estimateCostUsd(m.model, m.usage.inTokens, m.usage.outTokens)
        const usd = cost.known ? cost.usd : undefined
        const prev = byRole.get(step.agent)
        const viewIds = prev?.viewIds ?? new Set<string>()
        viewIds.add(view.sessionId)
        byRole.set(step.agent, {
          tokens: (prev?.tokens ?? 0) + tok,
          ...(usd !== undefined || prev?.usd !== undefined ? { usd: (prev?.usd ?? 0) + (usd ?? 0) } : {}),
          viewIds,
        })
      }
    }
  }
  return [...byRole.entries()]
    .map(([role, v]) => ({ role, tokens: v.tokens, ...(v.usd !== undefined ? { usd: v.usd } : {}), runs: v.viewIds.size }))
    .sort((a, b) => b.tokens - a.tokens)
}

/** Report-wide grand totals. `tokens`/`usd` UNDEFINED when NOTHING in the whole report reported
 *  usage/priceable usage (the honest '—', distinct from a real small sum); `ms` is ALWAYS summed
 *  (every step's durationMs is real). */
export interface GrandTotals {
  tokens?: number
  usd?: number
  ms: number
}

/**
 * Sum tokens/usd/ms across EVERY view in the report — PURE, reused by the "total usage" tiles.
 * Reuses aggregateRunMetrics per view so the grand total reconciles with the per-run rows by
 * construction (same honesty: tokens/usd stay undefined unless a run reported them).
 */
export function aggregateGrandTotals(views: SessionView[]): GrandTotals {
  let tokens: number | undefined
  let usd: number | undefined
  let ms = 0
  for (const view of views) {
    const r = aggregateRunMetrics(view)
    if (r.totalTokens !== undefined) tokens = (tokens ?? 0) + r.totalTokens
    if (r.totalUsd !== undefined) usd = (usd ?? 0) + r.totalUsd
    ms += r.totalMs
  }
  return { ...(tokens !== undefined ? { tokens } : {}), ...(usd !== undefined ? { usd } : {}), ms }
}

/** The four time-series granularities the dashboard buckets runs into. */
export type Granularity = 'daily' | 'weekly' | 'monthly' | 'yearly'

/** One time bucket: its display label + the run-start epoch range [start,end) it covers, with the
 *  tokens summed and runs counted into it. `tokens` is 0 for an empty bucket (a faint zero bar) —
 *  this is a COUNTABLE chart quantity, NOT the honesty-dashed cost total, so 0 is meaningful here. */
export interface TimeBucket {
  key: string       // stable react key (the bucket's start epoch)
  label: string     // axis label, e.g. "8 Haz" / "Jun 8" / "W23" / "2026"
  start: number     // bucket start (epoch-ms, inclusive)
  end: number       // bucket end (epoch-ms, exclusive)
  tokens: number    // tokens summed across runs that started in [start,end)
  runs: number      // count of runs that started in [start,end)
}

/** A single timed run for the series: its start epoch and token total (0 when usage was absent —
 *  the run still happened, so it counts toward the bucket's run count even at 0 tokens). */
export interface TimedRun { startedAt: number; tokens: number }

/** Local YYYY-MM-DD-ish day index — runs in the BROWSER, so local-time bucketing is correct
 *  ("today" means the user's today). Returns the epoch-ms of local midnight for `d`. */
function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}
/** Local Monday-start week. */
function startOfWeek(d: Date): number {
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const dow = (day.getDay() + 6) % 7 // 0 = Monday
  day.setDate(day.getDate() - dow)
  return day.getTime()
}
function startOfMonth(d: Date): number { return new Date(d.getFullYear(), d.getMonth(), 1).getTime() }
function startOfYear(d: Date): number { return new Date(d.getFullYear(), 0, 1).getTime() }

/** ISO-ish week number (1–53) for the weekly axis label. */
function isoWeek(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const dayNum = (date.getUTCDay() + 6) % 7
  date.setUTCDate(date.getUTCDate() - dayNum + 3)
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4))
  const week = 1 + Math.round(((date.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7)
  return week
}

/** Default bucket counts per granularity — a FIXED recent window so the chart reads as a real
 *  series even with sparse data (today's single day fills one bar, the rest render as faint zeros). */
export const BUCKET_COUNTS: Record<Granularity, number> = { daily: 7, weekly: 8, monthly: 6, yearly: 4 }

/**
 * Bucket timed runs into a fixed recent window ending at `now`, SUMMING tokens + counting runs per
 * bucket — PURE, so it is unit-tested and the component stays declarative. Honest note: current
 * data is sparse (often a single day), so most buckets come back empty (tokens:0, runs:0) — that's
 * EXPECTED and renders as faint zero bars. The chart is a real time series the moment a second
 * day's run lands; nothing is fabricated.
 *
 * - The window is the most-recent `count` buckets aligned to local day/week/month/year boundaries,
 *   ending with the bucket that contains `now`.
 * - A run lands in the bucket whose [start,end) contains its `startedAt`; runs outside the window
 *   are dropped (older than the window) — the window is "recent activity", not all-time.
 */
export function bucketRunsByTime(
  runs: TimedRun[],
  granularity: Granularity,
  now: number,
  count = BUCKET_COUNTS[granularity],
  locale?: string,
): TimeBucket[] {
  const nowDate = new Date(now)
  // The list of bucket-START epochs, oldest → newest, ending at the bucket containing `now`.
  const starts: number[] = []
  if (granularity === 'daily') {
    for (let i = count - 1; i >= 0; i--) starts.push(startOfDay(new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() - i)))
  } else if (granularity === 'weekly') {
    const base = startOfWeek(nowDate)
    for (let i = count - 1; i >= 0; i--) starts.push(base - i * 7 * 86_400_000)
  } else if (granularity === 'monthly') {
    for (let i = count - 1; i >= 0; i--) starts.push(startOfMonth(new Date(nowDate.getFullYear(), nowDate.getMonth() - i, 1)))
  } else {
    for (let i = count - 1; i >= 0; i--) starts.push(startOfYear(new Date(nowDate.getFullYear() - i, 0, 1)))
  }

  // Bucket ends: each bucket runs until the next bucket's start; the last until "now's next boundary".
  const buckets: TimeBucket[] = starts.map((start, i) => {
    const next = starts[i + 1]
    let end: number
    if (next !== undefined) end = next
    else if (granularity === 'daily') end = startOfDay(new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() + 1))
    else if (granularity === 'weekly') end = start + 7 * 86_400_000
    else if (granularity === 'monthly') { const s = new Date(start); end = startOfMonth(new Date(s.getFullYear(), s.getMonth() + 1, 1)) }
    else end = startOfYear(new Date(new Date(start).getFullYear() + 1, 0, 1))
    return { key: String(start), label: bucketLabel(new Date(start), granularity, locale), start, end, tokens: 0, runs: 0 }
  })

  for (const run of runs) {
    const b = buckets.find(bk => run.startedAt >= bk.start && run.startedAt < bk.end)
    if (!b) continue // outside the recent window — dropped
    b.tokens += run.tokens
    b.runs += 1
  }
  return buckets
}

/** Axis label for a bucket start, localized for daily/weekly/monthly; yearly is just the year. */
function bucketLabel(d: Date, granularity: Granularity, locale?: string): string {
  if (granularity === 'yearly') return String(d.getFullYear())
  if (granularity === 'weekly') return `W${isoWeek(d)}`
  if (granularity === 'monthly') return d.toLocaleDateString(locale, { month: 'short' })
  return d.toLocaleDateString(locale, { day: 'numeric', month: 'short' }) // daily
}
