import type { MockGitHubAdapter, RepoFile } from '../di/MockGitHubAdapter.js'
import type { VerifyToken } from '../verify/VerifyToken.js'

export class NotVerifiedError extends Error {
  constructor() {
    super('Cannot mint ApprovedPush: session is not verified (no VerifyToken)')
    this.name = 'NotVerifiedError'
  }
}

/**
 * Gate 4 — push gate.
 *
 * `ApprovedPush` is a branded/opaque token. Only `mintApprovedPush` can
 * construct it, and it requires a genuine `VerifyToken` (Gate 3) — which only
 * the verifier can produce from a real test run. `pushToGitHub` requires the
 * `ApprovedPush` token, so code that tries to push without a verified session
 * does not type-check, and a session cannot be verified without a real test.
 */
export type ApprovedPush = { readonly __brand: 'ApprovedPush'; readonly sessionId: string }

/**
 * Mint requires a VerifyToken for THIS session. The token is the proof of a real
 * passing test; without it, minting throws.
 */
export function mintApprovedPush(sessionId: string, verify: VerifyToken | null | undefined): ApprovedPush {
  if (!verify || verify.sessionId !== sessionId) throw new NotVerifiedError()
  return { __brand: 'ApprovedPush', sessionId }
}

export interface PushResult { ok: boolean; url: string }

/** Uncallable without the branded token → no push without a verified session. */
export async function pushToGitHub(token: ApprovedPush, gh: MockGitHubAdapter, files: RepoFile[]): Promise<PushResult> {
  await gh.pushFiles(token.sessionId, files)
  return { ok: true, url: `https://github.com/mock/${token.sessionId}` }
}
