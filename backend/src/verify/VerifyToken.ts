import type { VerifyToken } from '@akis/shared'
import type { TestRunResult } from './TestRunner.js'

export type { VerifyToken }

/**
 * Gate 3 — "verified" = a real test run. (Also Gate 2 by capability: only the
 * verifier holds a TestRunner, so only the verifier can obtain the branded
 * TestRunResult this requires.)
 *
 * `mintVerifyToken` is the single chokepoint that produces a VerifyToken, and it
 * FAILS CLOSED: only a genuine ≥1-test pass yields a token (else null → not
 * verified → no push). The token's `codeDigest` is read FROM the branded result
 * (computed by the runner over the files it actually ran), never from a caller
 * argument — so verification evidence is bound to the tested code.
 */
export function mintVerifyToken(sessionId: string, result: TestRunResult): VerifyToken | null {
  if (result.testsRun >= 1 && result.passed === true) {
    return { sessionId, testsRun: result.testsRun, codeDigest: result.codeDigest } as unknown as VerifyToken
  }
  return null
}
