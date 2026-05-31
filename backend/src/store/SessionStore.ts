import type { SessionState } from '@akis/shared'

/**
 * Session persistence seam. MockSessionStore (in-memory) for tests; a Drizzle
 * implementation backs the runtime in a later sub-project. Uses optimistic
 * locking on `version` to prevent lost updates under concurrent dispatch.
 */
export interface SessionStore {
  create(s: SessionState): Promise<void>
  get(id: string): Promise<SessionState | undefined>
  update(id: string, patch: Partial<SessionState>, expectedVersion: number): Promise<SessionState>
}
