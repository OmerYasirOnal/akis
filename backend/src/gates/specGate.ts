import type { SessionState, ApprovalToken, SpecArtifact } from '@akis/shared'
import { digestSpec } from '../verify/digest.js'

/**
 * Gate 1 — spec-approval (structural).
 *
 * `ApprovalToken` (shared, nominal-branded) is minted ONLY here, only from a
 * session whose `approval` token is present and matches its spec — and that
 * `approval` token is itself written only by the store's dedicated approval
 * method (so a generic `store.update({...})` patch cannot fabricate it).
 * `ProtoAgent.run` requires the returned `ApprovedSpec`, so code-write cannot run
 * without genuine human approval.
 */
export type ApprovedSpec = {
  readonly spec: SpecArtifact
  readonly token: ApprovalToken
}

export class SpecNotApprovedError extends Error {
  constructor() {
    super('Cannot proceed to code-write: session has no valid approval (Gate 1)')
    this.name = 'SpecNotApprovedError'
  }
}

/** Build an ApprovalToken for a reviewed spec. Single audited brand cast. */
export function brandApproval(spec: SpecArtifact): ApprovalToken {
  return { spec, specDigest: digestSpec(spec) } as unknown as ApprovalToken
}

/** Mint requires a present approval token whose digest matches its spec. */
export function mintApprovedSpec(session: SessionState): ApprovedSpec {
  const t = session.approval
  if (!t || t.specDigest !== digestSpec(t.spec)) throw new SpecNotApprovedError()
  return { spec: t.spec, token: t }
}
