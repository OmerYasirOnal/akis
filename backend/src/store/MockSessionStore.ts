import type { SessionState } from '@akis/shared'
import type { SessionStore } from './SessionStore.js'

export class MockSessionStore implements SessionStore {
  private map = new Map<string, SessionState>()

  async create(s: SessionState): Promise<void> {
    this.map.set(s.id, { ...s })
  }

  async get(id: string): Promise<SessionState | undefined> {
    const s = this.map.get(id)
    return s ? { ...s } : undefined
  }

  async update(id: string, patch: Partial<SessionState>, expectedVersion: number): Promise<SessionState> {
    const cur = this.map.get(id)
    if (!cur) throw new Error(`session ${id} not found`)
    if (cur.version !== expectedVersion) {
      throw new Error(`version conflict: ${cur.version} !== ${expectedVersion}`)
    }
    const next = { ...cur, ...patch, version: cur.version + 1 }
    this.map.set(id, next)
    return { ...next }
  }
}
