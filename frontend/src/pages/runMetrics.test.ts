import { describe, it, expect } from 'vitest'
import { aggregateRunMetrics } from './runMetrics.js'
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
})
