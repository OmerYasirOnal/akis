import type { Role } from '@akis/shared'
import { estimateCostUsd } from '@akis/shared'
import type { SessionView } from '../live/types.js'

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
