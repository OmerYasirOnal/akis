import { describe, it, expect, afterEach, vi } from 'vitest'
import { buildAgentMetrics } from '../../src/agent/metrics.js'

/** Date.now() is the ONLY source of durationMs (nextTs is a deterministic counter, not
 *  wall-clock ms). Stub it so durationMs is deterministic, never flaky. */
function withNow<T>(now: number, fn: () => T): T {
  const spy = vi.spyOn(Date, 'now').mockReturnValue(now)
  try { return fn() } finally { spy.mockRestore() }
}

describe('buildAgentMetrics (the single honesty choke point)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('present non-zero usage → copied; durationMs from the stubbed clock; toolCalls echoed', () => {
    const m = withNow(1_000, () => buildAgentMetrics({ inTokens: 120, outTokens: 80 }, 700, 3))
    expect(m).toEqual({ usage: { inTokens: 120, outTokens: 80 }, durationMs: 300, toolCalls: 3 })
  })

  it('undefined usage → NO usage key (durationMs + toolCalls still present)', () => {
    const m = withNow(500, () => buildAgentMetrics(undefined, 200, 1))
    expect(m).toEqual({ durationMs: 300, toolCalls: 1 })
    expect('usage' in m).toBe(false)
  })

  it('usage {0,0} → treated as ABSENT, NO usage key (the MockProvider-default honesty rule)', () => {
    const m = withNow(500, () => buildAgentMetrics({ inTokens: 0, outTokens: 0 }, 500, 2))
    expect('usage' in m).toBe(false)
    expect(m).toEqual({ durationMs: 0, toolCalls: 2 })
  })

  it('usage {0,5} or {5,0} → REPORTED (only BOTH-zero collapses to absent)', () => {
    const a = withNow(0, () => buildAgentMetrics({ inTokens: 0, outTokens: 5 }, 0, 0))
    expect(a.usage).toEqual({ inTokens: 0, outTokens: 5 })
    const b = withNow(0, () => buildAgentMetrics({ inTokens: 5, outTokens: 0 }, 0, 0))
    expect(b.usage).toEqual({ inTokens: 5, outTokens: 0 })
  })
})
