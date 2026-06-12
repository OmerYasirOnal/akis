import type { TestEvidence, ScenarioEvidence } from './session.js'

/**
 * P0-3a — HONEST FAILURE SUMMARY.
 *
 * Distill the verifier's structured {@link TestEvidence} into the small, bounded summary the
 * `verify` wire event + the orchestrator narration both surface, so a FAILED run can report what
 * ACTUALLY happened ("11 checks ran, 7 passed, 1 failed: '…', 3 could not be measured") instead of
 * the old "0 test / no real passing test was produced" lie.
 *
 * PURE + OBSERVABILITY-ONLY: it reads only structured evidence (names + counts + bounded reason
 * labels) and NEVER influences minting, the VerifyToken, or any gate — `passed` stays token-driven
 * upstream. STRUCTURED ONLY (never free-form prose), so it can never become trusted RAG grounding
 * nor carry a secret.
 *
 * Skip/unmeasured classification: a scenario the runner could not measure (an auth/interactive
 * criterion it had to skip) carries `passed:false` in the evidence — but it is NOT a hard failure.
 * boot-smoke records those with the reason `'skipped'` (e2e) / a FAILED-but-skipped marker; here we
 * treat ANY non-passing scenario whose reason is exactly `'skipped'` as UNMEASURED, never as a hard
 * failure. So passedCount + failedCount + unmeasuredCount === scenarios.length.
 */
export interface VerifyFailureSummary {
  /** Total scenarios/checks the evidence describes (passed + hard-failed + unmeasured). */
  totalChecks: number
  /** Scenarios that PASSED (real measured success count). */
  passedCount: number
  /** HARD failures — a measured scenario that did not pass (skips excluded). */
  failedCount: number
  /** Scenarios that could not be measured (skipped/interactive/auth). */
  unmeasuredCount: number
  /** Up to `cap` named HARD-failing scenarios with a bounded reason class. */
  failingScenarios: Array<{ name: string; reason: string }>
}

/** A scenario is UNMEASURED (skipped/interactive) iff it did not pass AND its reason is exactly
 *  `'skipped'`. Everything else that did not pass is a real, measured HARD failure. */
function isUnmeasured(s: ScenarioEvidence): boolean {
  return !s.passed && s.reason === 'skipped'
}

/** A short, bounded reason CLASS for a hard-failing scenario (never free-form prose). Prefers the
 *  structured `reason` (boot-smoke outcome like "missing literal" / "status 500"), then the failing
 *  `step`, then a generic "failed". Truncated so the wire/narration stays bounded. */
function reasonClass(s: ScenarioEvidence): string {
  const raw = (s.reason && s.reason.trim()) || (s.step && s.step.trim()) || 'failed'
  return raw.length > 80 ? `${raw.slice(0, 77)}…` : raw
}

/** Truncate a scenario display name so the wire event + narration stay bounded. */
function boundedName(name: string, max = 80): string {
  const n = name.trim()
  return n.length > max ? `${n.slice(0, max - 1)}…` : n
}

/**
 * Build the bounded {@link VerifyFailureSummary} from {@link TestEvidence}. `cap` bounds how many
 * named hard-failing scenarios ride along (default 3). Returns undefined when no evidence is
 * available (so callers degrade gracefully to the legacy wording).
 */
export function summarizeVerifyEvidence(
  evidence: TestEvidence | undefined,
  cap = 3,
): VerifyFailureSummary | undefined {
  if (!evidence) return undefined
  const scenarios = evidence.scenarios ?? []
  const passedCount = scenarios.filter(s => s.passed).length
  const unmeasured = scenarios.filter(isUnmeasured)
  const hardFailures = scenarios.filter(s => !s.passed && !isUnmeasured(s))
  return {
    totalChecks: scenarios.length,
    passedCount,
    failedCount: hardFailures.length,
    unmeasuredCount: unmeasured.length,
    failingScenarios: hardFailures.slice(0, cap).map(s => ({ name: boundedName(s.name), reason: reasonClass(s) })),
  }
}
