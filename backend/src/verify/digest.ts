import { createHash } from 'node:crypto'
import type { RepoFile } from '../di/MockGitHubAdapter.js'
import type { SpecArtifact, TestEvidence, ScenarioEvidence } from '@akis/shared'

/**
 * Length-prefixed encoding so distinct inputs can never collide by separator
 * ambiguity (e.g. file boundaries or a space inside a path/content). Each field
 * is written as `<byteLength>:<value>`, which is injective.
 */
function lp(s: string): string {
  return `${Buffer.byteLength(s, 'utf8')}:${s}`
}

/**
 * Stable, collision-resistant digest of a file set. Binds a VerifyToken to the
 * exact code that was tested, so "verified code" cannot diverge from "pushed
 * code". Files are sorted by path for order-independence.
 */
export function digestFiles(files: RepoFile[]): string {
  const h = createHash('sha256')
  for (const f of [...files].sort((a, b) => a.filePath.localeCompare(b.filePath))) {
    h.update(lp(f.filePath))
    h.update(lp(f.content))
  }
  return h.digest('hex')
}

/** Stable digest of a spec — binds an ApprovalToken to the exact reviewed spec. */
export function digestSpec(spec: SpecArtifact): string {
  return createHash('sha256').update(lp(spec.title)).update(lp(spec.body)).digest('hex')
}

/**
 * Stable, collision-resistant digest of the STRUCTURED {@link TestEvidence} — makes
 * "passed N tests" tamper-evident at the SAME structural rigor as `digestFiles`
 * (code-vs-pushed). Bound onto the VerifyToken as `evidenceDigest`, so a recorded
 * verification cannot be made to claim a different test outcome than the run produced.
 *
 * It is DERIVED from the evidence and purely ADDITIVE: it is computed alongside the
 * fail-closed pass decision and never feeds it (mint still requires a genuine
 * ≥1-test pass). Every field is written length-prefixed (`<byteLength>:<value>`, see
 * {@link lp}), so distinct evidence can never collide by separator ambiguity (e.g. a
 * scenario name whose boundary is ambiguous, or a space inside a label). Scenarios are
 * digested IN ORDER (the runner's reported order is part of the evidence identity).
 */
export function digestEvidence(ev: TestEvidence): string {
  const h = createHash('sha256')
  // Top-level run facts (the same shape the VerifyToken/Trust Report attest).
  h.update(lp(`testsRun=${ev.testsRun}`))
  h.update(lp(`passed=${ev.passed}`))
  h.update(lp(`durationMs=${ev.durationMs}`))
  // Aggregate counts for both suites — keyed + length-prefixed so a count swap is caught.
  h.update(lp(`bdd=${ev.bdd.built},${ev.bdd.run},${ev.bdd.passed},${ev.bdd.failed},${ev.bdd.skipped},${ev.bdd.durationMs}`))
  h.update(lp(`e2e=${ev.e2e.testsRun},${ev.e2e.passed},${ev.e2e.expected},${ev.e2e.unexpected},${ev.e2e.flaky},${ev.e2e.skipped},${ev.e2e.durationMs}`))
  // Per-scenario detail, in order. Count-prefixed so a truncation/append is caught too.
  h.update(lp(`scenarios=${ev.scenarios.length}`))
  for (const s of ev.scenarios) h.update(lp(scenarioField(s)))
  // Structured failure report (present only on a non-pass) — bound so a failure cannot
  // be silently dropped/edited. Empty marker when absent keeps the encoding injective.
  if (ev.failure) {
    h.update(lp(`failure=${ev.failure.failedCount}`))
    h.update(lp(`failureReason=${ev.failure.reason ?? ''}`))
    h.update(lp(`failureScenarios=${ev.failure.scenarios.length}`))
    for (const s of ev.failure.scenarios) h.update(lp(scenarioField(s)))
  } else {
    h.update(lp('failure='))
  }
  return h.digest('hex')
}

/** Injective, length-prefixed encoding of one scenario (name + suite + outcome + bounded
 *  failure labels). The inner separators are safe because each field is itself a single
 *  lp() unit at the call site; the explicit `|` here is only human-readable framing. */
function scenarioField(s: ScenarioEvidence): string {
  return `${lp(s.name)}|${lp(s.suite)}|${lp(String(s.passed))}|${lp(s.reason ?? '')}|${lp(s.step ?? '')}`
}
