import type { SessionState } from '@akis/shared'
import type { MockGitHubAdapter, RepoFile } from '../di/MockGitHubAdapter.js'

export class NotVerifiedError extends Error {
  constructor() {
    super('Cannot mint ApprovedPush: session is not verified')
    this.name = 'NotVerifiedError'
  }
}

/**
 * Gate 4 — push gate.
 *
 * `ApprovedPush` is a branded/opaque token. Only `mintApprovedPush` can
 * construct it, and only when the session is verified. `pushToGitHub` requires
 * the token, so code that tries to push without a verified+confirmed session
 * does not type-check.
 */
export type ApprovedPush = { readonly __brand: 'ApprovedPush'; readonly sessionId: string }

/** Mint requires verified === true. The human push-confirm action is the caller. */
export function mintApprovedPush(s: SessionState): ApprovedPush {
  if (!s.verified) throw new NotVerifiedError()
  return { __brand: 'ApprovedPush', sessionId: s.id }
}

export interface PushResult { ok: boolean; url: string }

/** Uncallable without the branded token → no push without verified + confirm. */
export async function pushToGitHub(token: ApprovedPush, gh: MockGitHubAdapter, files: RepoFile[]): Promise<PushResult> {
  await gh.pushFiles(token.sessionId, files)
  return { ok: true, url: `https://github.com/mock/${token.sessionId}` }
}
