import type { SessionState, ApprovalToken, VerifyToken } from '@akis/shared'

/**
 * Session persistence seam. MockSessionStore (in-memory) for tests; a Drizzle
 * implementation backs the runtime later. Optimistic locking on `version`.
 *
 * The gate-bearing fields (`approval`, `verifyToken`) are NOT writable through
 * the generic `update` patch — they have dedicated methods, so a stray
 * `store.update({...})` cannot fabricate approval or verification.
 */
export type SessionPatch = Partial<Omit<SessionState, 'approval' | 'verifyToken' | 'id' | 'version'>>

export interface SessionStore {
  create(s: SessionState): Promise<void>
  get(id: string): Promise<SessionState | undefined>
  update(id: string, patch: SessionPatch, expectedVersion: number): Promise<SessionState>
  /** Gate 1: the only way to persist an approval token. */
  recordApproval(id: string, approval: ApprovalToken, expectedVersion: number): Promise<SessionState>
  /** Gate 3: the only way to persist a verify token. */
  recordVerification(id: string, token: VerifyToken, expectedVersion: number): Promise<SessionState>
}
