import { describe, it, expect } from 'vitest'
import { aggregateRunMetrics, aggregateModelUsage, aggregateAgentTotals, aggregateGrandTotals, cleanRunTitle, bucketRunsByTime } from './runMetrics.js'
import { foldSessionView } from '../live/viewModel.js'
import type { AkisEvent } from '@akis/shared'

const ev = (e: Partial<AkisEvent> & { kind: AkisEvent['kind'] }): AkisEvent =>
  ({ agent: 'orchestrator', laneId: 'main', sessionId: 's1', ts: 0, ...(e as object) }) as AkisEvent

/** A full run: Scribe (present usage), Proto (present usage), Trace (usage absent, time only). */
function fullRunEvents(): AkisEvent[] {
  return [
    ev({ kind: 'agent_start', role: 'scribe', agent: 'scribe', laneId: 'main' }),
    ev({ kind: 'agent_end', role: 'scribe', ok: true, agent: 'scribe', laneId: 'main', metrics: { usage: { inTokens: 100, outTokens: 50 }, durationMs: 2_000, toolCalls: 1 } }),
    ev({ kind: 'agent_start', role: 'proto', agent: 'proto', laneId: 'main' }),
    ev({ kind: 'agent_end', role: 'proto', ok: true, agent: 'proto', laneId: 'main', metrics: { usage: { inTokens: 200, outTokens: 1500 }, durationMs: 5_000, toolCalls: 1 } }),
    ev({ kind: 'agent_start', role: 'trace', agent: 'trace', laneId: 'verify' }),
    ev({ kind: 'agent_end', role: 'trace', ok: true, agent: 'trace', laneId: 'verify', metrics: { durationMs: 1_000, toolCalls: 1 } }),
  ]
}

describe('cleanRunTitle (pure title cleanup)', () => {
  it('strips a leading markdown heading and takes the first meaningful line', () => {
    expect(cleanRunTitle('# Modern Not Alma Uygulaması\n## Kapsam\n- madde')).toBe('Modern Not Alma Uygulaması')
  })

  it('skips leading blank lines and code fences to reach the title', () => {
    expect(cleanRunTitle('\n\n```ts\nconst x = 1\n```\n## Oylama uygulaması')).toBe('Oylama uygulaması')
  })

  it('strips surrounding bold/italic/backtick markers and a trailing colon', () => {
    expect(cleanRunTitle('**Voting app:**')).toBe('Voting app')
    expect(cleanRunTitle('`my-cli`')).toBe('my-cli')
  })

  it('collapses inner whitespace and trims', () => {
    expect(cleanRunTitle('   Hello    world   ')).toBe('Hello world')
  })

  it('a plain title passes through unchanged', () => {
    expect(cleanRunTitle('Just a plain idea')).toBe('Just a plain idea')
  })

  it('an empty/all-blank idea returns empty (caller falls back)', () => {
    expect(cleanRunTitle('')).toBe('')
    expect(cleanRunTitle('\n   \n')).toBe('')
  })
})

describe('aggregateRunMetrics (pure per-run cost)', () => {
  it('sums tokens (in+out across reporting agents) and time across all agents', () => {
    const m = aggregateRunMetrics(foldSessionView('s1', fullRunEvents()))
    // Scribe 150 + Proto 1700 = 1850 tokens; Trace reports no usage (not summed).
    expect(m.totalTokens).toBe(1850)
    expect(m.totalMs).toBe(8_000) // 2000 + 5000 + 1000
  })

  it('a session where NO agent reported usage → totalTokens UNDEFINED (→ dash), totalMs still summed', () => {
    const events: AkisEvent[] = [
      ev({ kind: 'agent_start', role: 'trace', agent: 'trace', laneId: 'verify' }),
      ev({ kind: 'agent_end', role: 'trace', ok: true, agent: 'trace', laneId: 'verify', metrics: { durationMs: 1_500, toolCalls: 1 } }),
    ]
    const m = aggregateRunMetrics(foldSessionView('s1', events))
    expect(m.totalTokens).toBeUndefined()
    expect(m.totalMs).toBe(1_500)
  })

  it('per-agent breakdown lists each role once with its latest metrics', () => {
    const m = aggregateRunMetrics(foldSessionView('s1', fullRunEvents()))
    const roles = m.perAgent.map(a => a.role).sort()
    expect(roles).toEqual(['proto', 'scribe', 'trace'])
    const scribe = m.perAgent.find(a => a.role === 'scribe')
    expect(scribe).toMatchObject({ tok: 150, tools: 1, ms: 2_000 })
    const trace = m.perAgent.find(a => a.role === 'trace')
    expect(trace?.tok).toBeUndefined() // honest absence, never 0
    expect(trace).toMatchObject({ tools: 1, ms: 1_000 })
  })

  it('an ITERATING agent (two attempts) reconciles: sum(perAgent) === totals (Opus review MED)', () => {
    // The critic iterate loop reruns Proto — the breakdown row must show that agent's TRUE
    // cost including retries, so the table always sums to the headline totals.
    const events: AkisEvent[] = [
      ev({ kind: 'agent_start', role: 'proto', agent: 'proto', laneId: 'main' }),
      ev({ kind: 'agent_end', role: 'proto', ok: true, agent: 'proto', laneId: 'main', metrics: { durationMs: 5_000, toolCalls: 2, usage: { inTokens: 1_000, outTokens: 1_000 } } }),
      ev({ kind: 'agent_start', role: 'proto', agent: 'proto', laneId: 'main' }),
      ev({ kind: 'agent_end', role: 'proto', ok: true, agent: 'proto', laneId: 'main', metrics: { durationMs: 5_000, toolCalls: 3, usage: { inTokens: 1_000, outTokens: 1_000 } } }),
    ]
    const m = aggregateRunMetrics(foldSessionView('s1', events))
    expect(m.totalTokens).toBe(4_000)
    expect(m.totalMs).toBe(10_000)
    const proto = m.perAgent.find(a => a.role === 'proto')
    expect(proto).toMatchObject({ tok: 4_000, tools: 5, ms: 10_000 }) // reconciles, never half
  })

  it('a {0,0}-only run (mock) → totalTokens undefined (the metrics never carried usage)', () => {
    // The backend builder collapsed {0,0}→absent, so the agent_end carries NO usage — the
    // aggregate naturally dashes, guarding the honesty rule end to end.
    const events: AkisEvent[] = [
      ev({ kind: 'agent_start', role: 'scribe', agent: 'scribe', laneId: 'main' }),
      ev({ kind: 'agent_end', role: 'scribe', ok: true, agent: 'scribe', laneId: 'main', metrics: { durationMs: 800, toolCalls: 1 } }),
    ]
    const m = aggregateRunMetrics(foldSessionView('s1', events))
    expect(m.totalTokens).toBeUndefined()
    expect(m.perAgent[0]?.tok).toBeUndefined()
  })

  it('estimates cost from each agent model+tokens (#16): priced models sum; an unknown model never fabricates a cost', () => {
    const events: AkisEvent[] = [
      ev({ kind: 'agent_start', role: 'scribe', agent: 'scribe', laneId: 'main' }),
      ev({ kind: 'agent_end', role: 'scribe', ok: true, agent: 'scribe', laneId: 'main', metrics: { usage: { inTokens: 1_000_000, outTokens: 1_000_000 }, model: 'claude-opus-4-8', durationMs: 1_000, toolCalls: 0 } }),
      ev({ kind: 'agent_start', role: 'proto', agent: 'proto', laneId: 'main' }),
      ev({ kind: 'agent_end', role: 'proto', ok: true, agent: 'proto', laneId: 'main', metrics: { usage: { inTokens: 1_000, outTokens: 1_000 }, model: 'an-unlisted-model', durationMs: 1_000, toolCalls: 0 } }),
    ]
    const m = aggregateRunMetrics(foldSessionView('s1', events))
    expect(m.totalUsd).toBe(30) // Opus 1M in ($5) + 1M out ($25); the unlisted model is not priced
    expect(m.perAgent.find(a => a.role === 'scribe')?.usd).toBe(30)
    expect(m.perAgent.find(a => a.role === 'proto')?.usd).toBeUndefined() // unknown model → no fabricated $
  })

  it('usage WITHOUT a model (all-unknown) → totalUsd UNDEFINED (dash), tokens still summed', () => {
    const m = aggregateRunMetrics(foldSessionView('s1', fullRunEvents())) // metrics carry usage but no model
    expect(m.totalUsd).toBeUndefined()
    expect(m.totalTokens).toBe(1850)
  })
})

/** Two priced builds: build A (Opus Scribe) + build B (Opus Proto + unlisted-model Proto). */
function pricedView(id: string, events: AkisEvent[]) {
  return foldSessionView(id, events.map(e => ({ ...e, sessionId: id })))
}

describe('aggregateModelUsage (report-wide, by model)', () => {
  it('groups usage-bearing steps by model, sums tokens, prices known models, counts calls; sorts desc', () => {
    const a = pricedView('a', [
      ev({ kind: 'agent_start', role: 'scribe', agent: 'scribe', laneId: 'main' }),
      ev({ kind: 'agent_end', role: 'scribe', ok: true, agent: 'scribe', laneId: 'main', metrics: { usage: { inTokens: 1_000_000, outTokens: 1_000_000 }, model: 'claude-opus-4-8', durationMs: 1_000, toolCalls: 0 } }),
    ])
    const b = pricedView('b', [
      ev({ kind: 'agent_start', role: 'proto', agent: 'proto', laneId: 'main' }),
      ev({ kind: 'agent_end', role: 'proto', ok: true, agent: 'proto', laneId: 'main', metrics: { usage: { inTokens: 1_000, outTokens: 1_000 }, model: 'claude-opus-4-8', durationMs: 1_000, toolCalls: 0 } }),
      ev({ kind: 'agent_start', role: 'proto', agent: 'proto', laneId: 'main' }),
      ev({ kind: 'agent_end', role: 'proto', ok: true, agent: 'proto', laneId: 'main', metrics: { usage: { inTokens: 500, outTokens: 500 }, model: 'an-unlisted-model', durationMs: 1_000, toolCalls: 0 } }),
    ])
    const rows = aggregateModelUsage([a, b])
    const opus = rows.find(r => r.model === 'claude-opus-4-8')
    expect(opus).toMatchObject({ tokens: 2_002_000, calls: 2 }) // 1M+1M + 1k+1k tokens across 2 calls
    expect(opus?.usd).toBeCloseTo(30.03, 2) // 1M in $5 + 1M out $25 + (1k in + 1k out) ≈ $0.03
    const unlisted = rows.find(r => r.model === 'an-unlisted-model')
    expect(unlisted).toMatchObject({ tokens: 1_000, calls: 1 })
    expect(unlisted?.usd).toBeUndefined() // unknown model → no fabricated $
    expect(rows[0]?.model).toBe('claude-opus-4-8') // sorted desc by tokens
  })

  it('skips steps with no usage (LLM-free / mock {0,0}) — never a fabricated 0-token model row', () => {
    const v = pricedView('v', [
      ev({ kind: 'agent_start', role: 'trace', agent: 'trace', laneId: 'verify' }),
      ev({ kind: 'agent_end', role: 'trace', ok: true, agent: 'trace', laneId: 'verify', metrics: { durationMs: 1_000, toolCalls: 1 } }),
    ])
    expect(aggregateModelUsage([v])).toEqual([])
  })
})

describe('aggregateAgentTotals (report-wide, by agent)', () => {
  it('sums tokens/usd per role across views; runs = distinct views with usage; sorts desc', () => {
    const a = pricedView('a', [
      ev({ kind: 'agent_start', role: 'proto', agent: 'proto', laneId: 'main' }),
      ev({ kind: 'agent_end', role: 'proto', ok: true, agent: 'proto', laneId: 'main', metrics: { usage: { inTokens: 1_000_000, outTokens: 1_000_000 }, model: 'claude-opus-4-8', durationMs: 1_000, toolCalls: 0 } }),
      ev({ kind: 'agent_start', role: 'scribe', agent: 'scribe', laneId: 'main' }),
      ev({ kind: 'agent_end', role: 'scribe', ok: true, agent: 'scribe', laneId: 'main', metrics: { usage: { inTokens: 100, outTokens: 50 }, durationMs: 1_000, toolCalls: 0 } }),
    ])
    const b = pricedView('b', [
      ev({ kind: 'agent_start', role: 'proto', agent: 'proto', laneId: 'main' }),
      ev({ kind: 'agent_end', role: 'proto', ok: true, agent: 'proto', laneId: 'main', metrics: { usage: { inTokens: 1_000, outTokens: 1_000 }, model: 'claude-opus-4-8', durationMs: 1_000, toolCalls: 0 } }),
    ])
    const rows = aggregateAgentTotals([a, b])
    const proto = rows.find(r => r.role === 'proto')
    expect(proto).toMatchObject({ tokens: 2_002_000, runs: 2 }) // spent in BOTH builds
    expect(proto?.usd).toBeCloseTo(30.03, 2) // 1M+1M Opus ($30) + 1k+1k Opus ($0.03)
    const scribe = rows.find(r => r.role === 'scribe')
    expect(scribe).toMatchObject({ tokens: 150, runs: 1 })
    expect(scribe?.usd).toBeUndefined() // no model → unpriced
    expect(rows[0]?.role).toBe('proto') // sorted desc by tokens
  })
})

describe('aggregateGrandTotals (report-wide)', () => {
  it('sums tokens/usd/ms across views; ms always summed; tokens undefined when nothing reported', () => {
    const priced = pricedView('a', [
      ev({ kind: 'agent_start', role: 'proto', agent: 'proto', laneId: 'main' }),
      ev({ kind: 'agent_end', role: 'proto', ok: true, agent: 'proto', laneId: 'main', metrics: { usage: { inTokens: 1_000_000, outTokens: 1_000_000 }, model: 'claude-opus-4-8', durationMs: 5_000, toolCalls: 0 } }),
    ])
    const usageless = pricedView('b', [
      ev({ kind: 'agent_start', role: 'trace', agent: 'trace', laneId: 'verify' }),
      ev({ kind: 'agent_end', role: 'trace', ok: true, agent: 'trace', laneId: 'verify', metrics: { durationMs: 2_000, toolCalls: 1 } }),
    ])
    const g = aggregateGrandTotals([priced, usageless])
    expect(g.tokens).toBe(2_000_000)
    expect(g.usd).toBe(30)
    expect(g.ms).toBe(7_000) // 5000 + 2000, even the usageless run contributes time

    const none = aggregateGrandTotals([usageless])
    expect(none.tokens).toBeUndefined()
    expect(none.usd).toBeUndefined()
    expect(none.ms).toBe(2_000)
  })
})

describe('bucketRunsByTime (time-series, pure)', () => {
  // Pin "now" to a fixed local instant so the window is deterministic across machines.
  const now = new Date(2026, 5, 8, 12, 0, 0).getTime() // 2026-06-08 (a Monday) noon, local

  it('daily: returns the 7 most-recent day buckets ending today, oldest → newest', () => {
    const buckets = bucketRunsByTime([], 'daily', now)
    expect(buckets).toHaveLength(7)
    // Last bucket contains "now".
    const last = buckets[6]!
    expect(now).toBeGreaterThanOrEqual(last.start)
    expect(now).toBeLessThan(last.end)
    // Buckets ascend in time and each empty bucket reads as a zero bar.
    for (let i = 1; i < buckets.length; i++) expect(buckets[i]!.start).toBeGreaterThan(buckets[i - 1]!.start)
    expect(buckets.every(b => b.tokens === 0 && b.runs === 0)).toBe(true)
  })

  it('sums tokens + counts runs into the matching day bucket; usage-absent runs still count', () => {
    const today = now
    const twoDaysAgo = now - 2 * 86_400_000
    const buckets = bucketRunsByTime(
      [{ startedAt: today, tokens: 1000 }, { startedAt: today, tokens: 500 }, { startedAt: twoDaysAgo, tokens: 0 }],
      'daily', now,
    )
    const last = buckets[6]!
    expect(last.tokens).toBe(1500)
    expect(last.runs).toBe(2)
    const twoBack = buckets[4]! // 7 buckets, index 6 = today, index 4 = two days ago
    expect(twoBack.tokens).toBe(0)
    expect(twoBack.runs).toBe(1) // a 0-token run still happened
  })

  it('drops runs older than the window', () => {
    const old = now - 30 * 86_400_000 // 30 days ago — outside a 7-day daily window
    const buckets = bucketRunsByTime([{ startedAt: old, tokens: 9999 }], 'daily', now)
    expect(buckets.reduce((s, b) => s + b.tokens, 0)).toBe(0)
    expect(buckets.reduce((s, b) => s + b.runs, 0)).toBe(0)
  })

  it('weekly/monthly/yearly use their default window sizes and bucket the current run', () => {
    expect(bucketRunsByTime([], 'weekly', now)).toHaveLength(8)
    expect(bucketRunsByTime([], 'monthly', now)).toHaveLength(6)
    const yearly = bucketRunsByTime([{ startedAt: now, tokens: 2000 }], 'yearly', now)
    expect(yearly).toHaveLength(4)
    expect(yearly[3]!.tokens).toBe(2000) // this year's bucket
    expect(yearly[3]!.label).toBe('2026')
  })
})
