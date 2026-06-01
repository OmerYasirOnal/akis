/**
 * VerifyToken — the proof, carried in SessionState, that a real test run passed.
 *
 * It is BRANDED, so it cannot be written into the session as a plain object
 * literal (a store holder cannot fabricate `{ ...token }` and have it type-check
 * where a VerifyToken is required). It can only be produced by the verify module
 * (from a real TestRunResult), so the persisted/emitted verification state is
 * underivable from outside the gate — closing the "false green".
 *
 * It binds to the session AND to a digest of the exact code that was tested, so
 * "verified code" cannot diverge from "pushed code".
 */
export type VerifyToken = {
  readonly __brand: 'VerifyToken'
  readonly sessionId: string
  readonly testsRun: number
  readonly codeDigest: string
}
