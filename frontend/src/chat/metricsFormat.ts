import type { AgentMetrics } from '@akis/shared'
import type { StringKey } from '../i18n/catalog.js'

/** Format a token count Claude-Code-style: ≥1000 → "12.3k" (1 decimal), else the raw number. */
export function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

/** Format an ESTIMATED USD cost compactly: "<$0.01" → "<$0.01"; "<$1" → "$0.42"; else "$1.23".
 *  Always prefixed by the caller's "est." label so it never reads as an exact charge. */
export function fmtUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return '<$0.01'
  return `$${usd.toFixed(2)}`
}

/** Format a wall-clock duration: "<60s" → "42s"; otherwise "1m 33s". */
export function fmtDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}m ${s}s`
}

/**
 * Build the compact metrics badge string, e.g. "12.3k tok · 1 tool · 42s". HONEST:
 * - the `tok` segment is OMITTED entirely when usage is absent (Trace, mock {0,0}, deferred
 *   critic) — never a fabricated "0 tok". Token count = inTokens + outTokens.
 * - `tool`/`tools` picks singular/plural via the count (both keys exist in EN+TR so neither
 *   locale falls back).
 * - returns undefined when the metrics carry NEITHER usage NOR durationMs (nothing to show).
 * The shared dash sentinel for absent values is rendered by callers, not here (it is the
 * literal '—', identical in both locales — no i18n key).
 */
export function metricsBadge(t: (k: StringKey) => string, m: AgentMetrics): string | undefined {
  const parts: string[] = []
  if (m.usage) parts.push(`${fmtTokens(m.usage.inTokens + m.usage.outTokens)} ${t('metrics.tok')}`)
  if (m.toolCalls !== undefined && m.toolCalls > 0) {
    parts.push(`${m.toolCalls} ${t(m.toolCalls === 1 ? 'metrics.tool' : 'metrics.tools')}`)
  }
  if (m.durationMs !== undefined) parts.push(fmtDuration(m.durationMs))
  if (!m.usage && m.durationMs === undefined) return undefined
  return parts.length ? parts.join(' · ') : undefined
}
