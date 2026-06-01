import type { SessionState, SpecArtifact } from '@akis/shared'

/**
 * Gate 1 — spec-approval (structural).
 *
 * `ApprovedSpec` is a branded token mintable only from a session that already
 * carries an `approvedSpec` (which only the human `approve()` sets). `ProtoAgent.run`
 * requires this token instead of a plain SpecArtifact, so code-write cannot be
 * called — it cannot even type-check — without an approved spec. No direct
 * caller of the producer can side-step approval.
 */
export type ApprovedSpec = {
  readonly __brand: 'ApprovedSpec'
  readonly spec: SpecArtifact
}

export class SpecNotApprovedError extends Error {
  constructor() {
    super('Cannot mint ApprovedSpec: session has no approved spec (Gate 1)')
    this.name = 'SpecNotApprovedError'
  }
}

/** Mint requires session.approvedSpec to be present (set only by approve()). */
export function mintApprovedSpec(session: SessionState): ApprovedSpec {
  if (!session.approvedSpec) throw new SpecNotApprovedError()
  return { __brand: 'ApprovedSpec', spec: session.approvedSpec }
}
