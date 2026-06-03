import type { SessionState } from '@akis/shared'
import { isVerified } from '@akis/shared'
import type { GitHubAdapter, RepoFile } from '../di/MockGitHubAdapter.js'
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
 * `ApprovedPush` is NOMINAL-branded (a `unique symbol` private to this module),
 * so it cannot be written as a literal. `mintApprovedPush` is the only producer,
 * and it requires the session's genuine VerifyToken (Gate 3) AND files whose
 * digest matches the token. `pushToGitHub` requires the token, so push without a
 * verified session does not type-check and pushed-code cannot differ from
 * verified-code.
 */
declare const pushBrand: unique symbol

export type ApprovedPush = {
  readonly [pushBrand]: true
  readonly sessionId: string
}

/** Mint requires the session's persisted VerifyToken AND files matching its digest. */
export function mintApprovedPush(session: SessionState, files: RepoFile[]): ApprovedPush {
  if (!isVerified(session) || !session.verifyToken) throw new NotVerifiedError()
  if (session.verifyToken.codeDigest !== digestFiles(files)) throw new CodeMismatchError()
  return { sessionId: session.id } as unknown as ApprovedPush
}

export interface PushResult { ok: boolean; url: string }

/** Uncallable without the branded token → no push without a verified session.
 *  Accepts any `GitHubAdapter` (mock default; the opt-in RealGitHubAdapter is the
 *  production counterpart) — the ApprovedPush requirement is the SOLE entry, so a
 *  real adapter cannot be reached without a verified-and-digest-bound token. */
export async function pushToGitHub(token: ApprovedPush, gh: GitHubAdapter, files: RepoFile[]): Promise<PushResult> {
  await gh.pushFiles(token.sessionId, files)
  return { ok: true, url: `https://github.com/mock/${token.sessionId}` }
}
