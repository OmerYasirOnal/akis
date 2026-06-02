/**
 * VerifyToken — the proof, carried in SessionState, that a real test run passed.
 *
 * NOMINAL BRAND via a `unique symbol`: the brand key has no runtime value and is
 * not nameable outside this module, so a VerifyToken cannot be written as an
 * object literal anywhere — `{ sessionId, testsRun, codeDigest }` is missing the
 * brand and fails to type-check, and even `... as VerifyToken` fails (TS2352).
 * Only `mintVerifyToken` (verify module) constructs one, via a single audited
 * cast. This is a real construction-time guarantee, unlike a `__brand: 'string'`
 * field (which is freely assignable).
 *
 * Honest boundary: in a single process, TypeScript cannot stop a same-graph
 * module from calling the exported minter or using `as unknown as`. The
 * guarantees here are: (1) no accidental/literal forgery, (2) verification flows
 * only through the verifier capability (DI), (3) fail-closed. A hard trust
 * boundary (process/role isolation) is future work.
 */
declare const verifyBrand: unique symbol

export type VerifyToken = {
  readonly [verifyBrand]: true
  readonly sessionId: string
  readonly testsRun: number
  readonly codeDigest: string
}
