import type { SessionState, VerifyToken } from '@akis/shared'
import { isVerified } from '@akis/shared'
import type { MockGitHubAdapter, RepoFile } from '../di/MockGitHubAdapter.js'
import { digestFiles } from '../verify/digest.js'

export class NotVerifiedError extends Error {
  constructor() {
    super('Cannot mint ApprovedPush: session is not verified (no VerifyToken)')
    this.name = 'NotVerifiedError'
  }
}

export class CodeMismatchError extends Error {
  constructor() {
    super('Cannot push: the code to push does not match the verified code')
    this.name = 'CodeMismatchError'
  }
}

/**
 * Gate 4 — push gate.
 *
 * `ApprovedPush` is a branded/opaque token. Only `mintApprovedPush` can
 * construct it, and only from a session that carries a genuine VerifyToken
 * (Gate 3) whose digest matches the files being pushed. `pushToGitHub` requires
 * the `ApprovedPush` token, so code that pushes without a verified session does
 * not type-check, a session cannot be verified without a real test, and the
 * pushed files cannot differ from the verified files.
 */
export type ApprovedPush = {
  readonly __brand: 'ApprovedPush'
  readonly sessionId: string
  readonly verify: VerifyToken
}

/** Mint requires the session's persisted VerifyToken AND files matching its digest. */
export function mintApprovedPush(session: SessionState, files: RepoFile[]): ApprovedPush {
  if (!isVerified(session) || !session.verifyToken) throw new NotVerifiedError()
  if (session.verifyToken.codeDigest !== digestFiles(files)) throw new CodeMismatchError()
  return { __brand: 'ApprovedPush', sessionId: session.id, verify: session.verifyToken }
}

export interface PushResult { ok: boolean; url: string }

/** Uncallable without the branded token → no push without a verified session. */
export async function pushToGitHub(token: ApprovedPush, gh: MockGitHubAdapter, files: RepoFile[]): Promise<PushResult> {
  await gh.pushFiles(token.sessionId, files)
  return { ok: true, url: `https://github.com/mock/${token.sessionId}` }
}
