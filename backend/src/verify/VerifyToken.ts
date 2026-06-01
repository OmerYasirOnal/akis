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
 * verified → no push). It requires a branded `TestRunResult` (unforgeable as a
 * literal), so a caller must have actually run a TestRunner to get here. The
 * token binds the session id + a digest of the tested code.
 *
 * The single audited brand cast lives here; the brand symbol is private to
 * @akis/shared so no other module can apply it.
 */
export function mintVerifyToken(sessionId: string, codeDigest: string, result: TestRunResult): VerifyToken | null {
  if (result.testsRun >= 1 && result.passed === true) {
    return { sessionId, testsRun: result.testsRun, codeDigest } as unknown as VerifyToken
  }
  return null
}
