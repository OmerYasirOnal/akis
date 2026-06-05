import type { SessionState, ApprovalToken, VerifyToken } from '@akis/shared'
import type { SessionStore, SessionPatch } from './SessionStore.js'

export class MockSessionStore implements SessionStore {
  private map = new Map<string, SessionState>()

  async create(s: SessionState): Promise<void> {
    this.map.set(s.id, { ...s })
  }

  async get(id: string): Promise<SessionState | undefined> {
    const s = this.map.get(id)
    return s ? { ...s } : undefined
  }

  private commit(id: string, expectedVersion: number, mutate: (cur: SessionState) => SessionState): SessionState {
    const cur = this.map.get(id)
    if (!cur) throw new Error(`session ${id} not found`)
    if (cur.version !== expectedVersion) {
      throw new Error(`version conflict: ${cur.version} !== ${expectedVersion}`)
    }
    const next = { ...mutate(cur), version: cur.version + 1 }
    this.map.set(id, next)
    return { ...next }
  }

  async update(id: string, patch: SessionPatch, expectedVersion: number): Promise<SessionState> {
    return this.commit(id, expectedVersion, cur => ({ ...cur, ...patch }))
  }

  async recordApproval(id: string, approval: ApprovalToken, expectedVersion: number): Promise<SessionState> {
    return this.commit(id, expectedVersion, cur => ({ ...cur, approval }))
  }

  async recordVerification(id: string, token: VerifyToken, expectedVersion: number): Promise<SessionState> {
    return this.commit(id, expectedVersion, cur => ({ ...cur, verifyToken: token }))
  }

  async listByOwner(ownerId: string): Promise<SessionState[]> {
    // Map preserves insertion order; reverse for newest-first.
    return [...this.map.values()].filter(s => s.ownerId === ownerId).reverse().map(s => ({ ...s }))
  }

  /** Dev persistence seam (mirrors UserStore): dump every session for a file snapshot. */
  snapshot(): SessionState[] { return [...this.map.values()].map(s => ({ ...s })) }
  /** Replace the in-memory state from a snapshot (boot-time hydrate; insertion order kept). */
  hydrate(sessions: SessionState[]): void {
    this.map = new Map(sessions.map(s => [s.id, { ...s }]))
  }
}
