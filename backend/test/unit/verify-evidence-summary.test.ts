/**
 * P0-3a — the shared `summarizeVerifyEvidence` helper distils the verifier's structured evidence
 * into the bounded honest-failure summary the verify event + narration surface. The load-bearing
 * rules: a SKIPPED scenario (reason 'skipped') is UNMEASURED, never a hard failure; named hard
 * failures are capped; absent/zero-check evidence degrades to undefined/empty so callers can fall
 * back to the legacy wording. PURE + observability-only (never a gate input).
 */
import { describe, it, expect } from 'vitest'
import { summarizeVerifyEvidence, type TestEvidence } from '@akis/shared'

function evidence(scenarios: TestEvidence['scenarios']): TestEvidence {
  const failed = scenarios.filter(s => !s.passed)
  return {
    testsRun: scenarios.filter(s => s.reason !== 'skipped').length,
    passed: failed.length === 0,
    durationMs: 0,
    bdd: { built: 0, run: 0, passed: 0, failed: 0, skipped: 0, durationMs: 0 },
    e2e: { testsRun: 0, passed: false, expected: 0, unexpected: 0, flaky: 0, skipped: 0, durationMs: 0 },
    scenarios,
    failure: { failedCount: failed.length, scenarios: failed },
  }
}

describe('summarizeVerifyEvidence (P0-3a)', () => {
  it('classifies passed / hard-failed / skipped (skips are NOT hard failures)', () => {
    const ev = evidence([
      { name: 'boot', suite: 'e2e', passed: true },
      { name: 'assets', suite: 'e2e', passed: true },
      { name: 'clicks the delete (Sil)', suite: 'e2e', passed: false, reason: 'missing literal' },
      { name: 'auth-gated route', suite: 'e2e', passed: false, reason: 'skipped' },
      { name: 'interactive flow', suite: 'e2e', passed: false, reason: 'skipped' },
    ])
    const s = summarizeVerifyEvidence(ev)!
    expect(s.totalChecks).toBe(5)
    expect(s.passedCount).toBe(2)
    expect(s.failedCount).toBe(1) // ONLY the missing-literal hard failure
    expect(s.unmeasuredCount).toBe(2) // the two skips
    expect(s.failingScenarios).toEqual([{ name: 'clicks the delete (Sil)', reason: 'missing literal' }])
  })

  it('caps failingScenarios at the requested count (default 3)', () => {
    const ev = evidence(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}`, suite: 'e2e' as const, passed: false, reason: `status ${500 + i}` })))
    const s = summarizeVerifyEvidence(ev)!
    expect(s.failedCount).toBe(5)
    expect(s.failingScenarios).toHaveLength(3)
    expect(summarizeVerifyEvidence(ev, 1)!.failingScenarios).toHaveLength(1)
  })

  it('prefers reason, then step, then "failed" for the bounded reason class', () => {
    const ev = evidence([
      { name: 'a', suite: 'bdd', passed: false, step: 'Given a step' },
      { name: 'b', suite: 'bdd', passed: false },
    ])
    const s = summarizeVerifyEvidence(ev)!
    expect(s.failingScenarios[0]).toEqual({ name: 'a', reason: 'Given a step' })
    expect(s.failingScenarios[1]).toEqual({ name: 'b', reason: 'failed' })
  })

  it('truncates an over-long scenario name / reason so the summary stays bounded', () => {
    const ev = evidence([{ name: 'x'.repeat(200), suite: 'e2e', passed: false, reason: 'y'.repeat(200) }])
    const f = summarizeVerifyEvidence(ev)!.failingScenarios[0]!
    expect(f.name.length).toBeLessThanOrEqual(80)
    expect(f.reason.length).toBeLessThanOrEqual(80)
    expect(f.name.endsWith('…')).toBe(true)
    expect(f.reason.endsWith('…')).toBe(true)
  })

  it('returns undefined for absent evidence (caller falls back to legacy wording)', () => {
    expect(summarizeVerifyEvidence(undefined)).toBeUndefined()
  })

  it('a zero-check evidence summary reports totalChecks 0 (so the narration degrades)', () => {
    const s = summarizeVerifyEvidence(evidence([]))!
    expect(s.totalChecks).toBe(0)
    expect(s.passedCount).toBe(0)
    expect(s.failedCount).toBe(0)
    expect(s.failingScenarios).toEqual([])
  })
})
