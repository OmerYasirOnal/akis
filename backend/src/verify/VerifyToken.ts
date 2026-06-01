import type { VerifyToken } from '@akis/shared'
import type { TestRunResult } from './TestRunner.js'

export type { VerifyToken }

/**
 * Gate 3 — "verified" = a real test run. (Also enforces Gate 2 by capability:
 * only the verifier holds a TestRunner, so only the verifier can obtain the
 * branded TestRunResult required to mint this token.)
 *
 * `mintVerifyToken` is the ONLY producer of a VerifyToken, and it FAILS CLOSED:
 * anything other than a genuine ≥1-test pass returns null (no token → not
 * verified → no push). The token binds to the session AND a digest of the exact
 * tested code, so verified-code cannot diverge from pushed-code.
 *
 * The token is persisted in SessionState (`verifyToken`); the session's verified
 * state is the PRESENCE of that token (shared `isVerified`), never a free
 * boolean — so the store cannot be made to claim verification without proof.
 */
export function mintVerifyToken(sessionId: string, codeDigest: string, result: TestRunResult): VerifyToken | null {
  if (result.testsRun >= 1 && result.passed === true) {
    return { __brand: 'VerifyToken', sessionId, testsRun: result.testsRun, codeDigest }
  }
  return null
}
