import type { SpecArtifact } from './session.js'

/**
 * ApprovalToken — proof that the human approved a specific reviewed spec (Gate 1).
 *
 * NOMINAL BRAND via a `unique symbol` (see verify.ts for the rationale). It
 * carries the approved spec and a digest of it, so approval binds to the exact
 * reviewed content. It cannot be written as a literal; only the orchestrator's
 * `approve()` path constructs one (via the store's dedicated approval method),
 * so a generic `store.update({ approvedSpec })` patch cannot fabricate approval.
 */
declare const approvalBrand: unique symbol

export type ApprovalToken = {
  readonly [approvalBrand]: true
  readonly spec: SpecArtifact
  readonly specDigest: string
}
