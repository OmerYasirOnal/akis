import type { VerifyToken } from './verify.js'

export type SessionStatus =
  | 'composing' | 'awaiting_spec_approval' | 'building'
  | 'awaiting_critic_resolution' | 'awaiting_push_confirm'
  | 'done' | 'failed' | 'cancelled'

export interface SpecArtifact { title: string; body: string }
export interface CodeArtifact { files: { filePath: string; content: string }[] }

export interface SessionState {
  id: string
  status: SessionStatus
  idea: string
  spec?: SpecArtifact
  approvedSpec?: SpecArtifact   // set only by human approve(); Gate 1 keys on this
  code?: CodeArtifact
  /**
   * Gate 3: verification is the PRESENCE of a branded VerifyToken, not a free
   * boolean. A VerifyToken can only be minted from a real passing test run, and
   * cannot be written as a literal, so the store cannot be made to claim
   * verification without genuine proof. Persisted, so it survives restart.
   */
  verifyToken?: VerifyToken
  version: number               // optimistic lock
}

/** Derived verification state — the single source of truth the outside world reads. */
export function isVerified(s: SessionState): boolean {
  return s.verifyToken != null && s.verifyToken.sessionId === s.id
}

export function initialSession(id: string, idea: string): SessionState {
  return { id, status: 'composing', idea, version: 0 }
}
