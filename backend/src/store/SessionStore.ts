import type { SessionState, ApprovalToken, VerifyToken } from '@akis/shared'

/**
 * Session persistence seam. MockSessionStore (in-memory) for tests; a Drizzle
 * implementation backs the runtime later. Optimistic locking on `version`.
 *
 * The gate-bearing fields (`approval`, `verifyToken`) are NOT writable through
 * the generic `update` patch — they have dedicated methods, so a stray
 * `store.update({...})` cannot fabricate approval or verification. `base` (the
 * Phase B.5 edit-mode seed) is likewise excluded: set ONLY at session creation
 * via the controlled API path, immutable thereafter.
 */
export type SessionPatch = Partial<Omit<SessionState, 'approval' | 'verifyToken' | 'id' | 'version' | 'base'>>

export interface SessionStore {
  create(s: SessionState): Promise<void>
  get(id: string): Promise<SessionState | undefined>
  update(id: string, patch: SessionPatch, expectedVersion: number): Promise<SessionState>
  /** Gate 1: the only way to persist an approval token. */
  recordApproval(id: string, approval: ApprovalToken, expectedVersion: number): Promise<SessionState>
  /** Gate 3: the only way to persist a verify token. */
  recordVerification(id: string, token: VerifyToken, expectedVersion: number): Promise<SessionState>
  /** All sessions owned by a user, newest first (per-user build history). */
  listByOwner(ownerId: string): Promise<SessionState[]>
}
