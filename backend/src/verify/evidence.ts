import type { TestEvidence, ScenarioEvidence } from '@akis/shared'
import type { BddStats, BddScenario } from '../bdd/messageStats.js'
import type { E2eStats, E2eScenario } from '../e2e/playwrightStats.js'

/**
 * Build the ADDITIVE, NON-GATE {@link TestEvidence} from the runner's rich stats +
 * per-scenario detail. This is OBSERVABILITY ONLY: it is computed alongside the
 * fail-closed pass/fail decision but NEVER feeds it — the VerifyToken still mints
 * only from a genuine ≥1-test pass (see verifier.ts/mint). The evidence is
 * STRUCTURED (names + counts + bounded labels), never free-form prose and never a
 * secret, so it can never become trusted RAG grounding.
 *
 * `passed` is the run outcome MIRROR for display (computed by the caller exactly as
 * the gate computes it). On a non-pass, a structured `failure` report lists the
 * named failing scenarios + bounded reasons — the future self-repair loop / Trust
 * Report read this.
 */
export function buildTestEvidence(input: {
  passed: boolean
  bdd: BddStats
  e2e: E2eStats
  bddScenarios: BddScenario[]
  e2eScenarios: E2eScenario[]
}): TestEvidence {
  const scenarios: ScenarioEvidence[] = [
    ...input.bddScenarios.map(toBdd),
    ...input.e2eScenarios.map(toE2e),
  ]
  const testsRun = input.bdd.run + input.e2e.testsRun
  const durationMs = input.bdd.durationMs + input.e2e.durationMs
  const failed = scenarios.filter(s => !s.passed)
  // When the run did NOT pass but no per-scenario failure was captured (a timeout, zero tests,
  // or all-skipped), record a top-level reason so the failure signal is never empty — the
  // self-repair loop + Trust Report need a non-empty signal even on these non-scenario modes.
  const failureReason = input.passed || failed.length > 0
    ? undefined
    : testsRun === 0
      ? 'no tests were executed'
      : 'run did not pass and no failing scenario was captured (e.g. a timeout or all scenarios skipped)'
  return {
    testsRun,
    passed: input.passed,
    durationMs,
    bdd: { ...input.bdd },
    e2e: { ...input.e2e },
    scenarios,
    ...(input.passed ? {} : { failure: { failedCount: failed.length, scenarios: failed, ...(failureReason ? { reason: failureReason } : {}) } }),
  }
}

function toBdd(s: BddScenario): ScenarioEvidence {
  return {
    name: s.name,
    suite: 'bdd',
    passed: s.passed,
    ...(s.failedStatus ? { reason: s.failedStatus } : {}),
    ...(s.failedStep ? { step: s.failedStep } : {}),
  }
}

function toE2e(s: E2eScenario): ScenarioEvidence {
  return {
    name: s.name,
    suite: 'e2e',
    passed: s.passed,
    ...(s.outcome ? { reason: s.outcome } : {}),
  }
}
