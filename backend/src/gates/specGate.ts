import type { SessionState, ApprovalToken, SpecArtifact } from '@akis/shared'
import { digestSpec } from '../verify/digest.js'

/**
 * Gate 1 — spec-approval (structural).
 *
 * The approval MINT (`brand`) is module-private and exposed ONLY through the
 * `ApprovalAuthority` capability, which the DI container hands to the
 * orchestrator. No other module can `import` a way to mint an approval — a forge
 * attempt is a COMPILE ERROR (TS2305). `mintApprovedSpec` is the read-side GATE
 * CHECK (safe to export): it throws unless the session carries a valid approval
 * token whose digest matches its spec, so `ProtoAgent.run` cannot run without
 * genuine human approval.
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

/** Single, module-private brand site for an approval token. */
function brand(spec: SpecArtifact): ApprovalToken {
  return { spec, specDigest: digestSpec(spec) } as unknown as ApprovalToken
}

/**
 * The approval capability — the only way to produce an ApprovalToken. Held by
 * the orchestrator via DI; built by the DI container. A first-party module
 * cannot import a bare approval minter.
 */
export interface ApprovalAuthority {
  approve(spec: SpecArtifact): ApprovalToken
}

export function createApprovalAuthority(): ApprovalAuthority {
  return { approve: (spec) => brand(spec) }
}

/**
 * Gate check: throws unless a present approval token is self-consistent AND bound
 * to the session's reviewed spec (closes the spec-substitution variant — a token
 * cannot approve a spec body different from the one the critic reviewed).
 */
export function mintApprovedSpec(session: SessionState): ApprovedSpec {
  const t = session.approval
  if (!t || t.specDigest !== digestSpec(t.spec)) throw new SpecNotApprovedError()
  if (!session.spec || digestSpec(t.spec) !== digestSpec(session.spec)) throw new SpecNotApprovedError()
  return { spec: t.spec, token: t }
}
