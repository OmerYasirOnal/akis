import type { TestRunResult } from './TestRunner.js'

/**
 * Gate 3 — "verified" = a real test run. (Also enforces Gate 2 by capability:
 * only the verifier holds a TestRunner, so only the verifier can obtain the
 * TestRunResult required to mint this token.)
 *
 * A VerifyToken is the ONLY proof of verification. It is mintable solely from a
 * branded TestRunResult that reports at least one executed, passing test. The
 * session's `verified` flag is set from the presence of a token, never from a
 * forgeable event field, so a producer cannot manufacture verification.
 *
 * `mintVerifyToken` FAILS CLOSED: anything other than a genuine ≥1-test pass
 * returns null (no token → not verified → no push). This makes the "false
 * green" the product exists to prevent structurally impossible.
 */
export type VerifyToken = {
  readonly __brand: 'VerifyToken'
  readonly sessionId: string
  readonly testsRun: number
}

export function mintVerifyToken(sessionId: string, result: TestRunResult): VerifyToken | null {
  if (result.testsRun >= 1 && result.passed === true) {
    return { __brand: 'VerifyToken', sessionId, testsRun: result.testsRun }
  }
  return null
}
