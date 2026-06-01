import type { VerifyToken } from './verify.js'
import type { ApprovalToken } from './approval.js'

export type SessionStatus =
  | 'composing' | 'awaiting_spec_approval' | 'building'
  | 'awaiting_critic_resolution' | 'awaiting_push_confirm'
  | 'done' | 'push_failed' | 'failed' | 'cancelled'

export interface SpecArtifact { title: string; body: string }
export interface CodeArtifact { files: { filePath: string; content: string }[] }

export interface SessionState {
  id: string
  status: SessionStatus
  idea: string
  spec?: SpecArtifact
  /**
   * Gate 1: approval is a branded ApprovalToken (not a plain spec field), so a
   * generic store patch cannot fabricate it. Set only via the store's dedicated
   * approval method, which the orchestrator's approve() calls.
   */
  approval?: ApprovalToken
  code?: CodeArtifact
  /**
   * Gate 3: verification is the PRESENCE of a branded VerifyToken (real ≥1-test
   * pass), never a free boolean. The brand cannot be written as a literal, so the
   * store cannot be made to claim verification. Persisted, so it survives restart.
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
