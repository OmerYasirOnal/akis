import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { SessionState, ApprovalToken, VerifyToken } from '@akis/shared'
import { MockSessionStore } from './MockSessionStore.js'
import type { SessionSummary } from './SessionStore.js'
import type { SessionStore, SessionPatch } from './SessionStore.js'

/**
 * DEV-ONLY file-persisted session store: the in-memory {@link MockSessionStore} plus a
 * JSON file (~/.akis/dev-sessions.json, 0600) saved on every mutation and loaded on boot —
 * so editing backend code (tsx-watch restart) NO LONGER DELETES BUILDS. This was the
 * recurring live pain ("Scribe'da çok uzun süre oldu" = a frozen view of a session the
 * restart had wiped): nothing was deleting sessions; they only ever lived in RAM.
 *
 * Scope and honesty (mirrors JsonFileUserStore exactly):
 *  - DEV ONLY. Production uses Postgres (PgSessionStore) when DATABASE_URL is set; this
 *    store is selected only on the non-production, non-test default path (server.ts).
 *  - TRUST: rehydrated approval/verifyToken come back as plain objects — the SAME
 *    semantic the Pg store already has ("verified survives a fresh instance" is an
 *    existing, tested property). Persistence ATTESTS what was already earned; the gate
 *    fields stay protected by the store API exactly as in memory.
 *  - Sessions hold spec/code/evidence — no secrets (provider keys live in the KeyStore).
 *    0600 regardless.
 *  - BEST-EFFORT persistence: an unwritable disk degrades to in-memory with one warning.
 */
export class JsonFileSessionStore implements SessionStore {
  private inner = new MockSessionStore()
  private warned = false

  constructor(private file = join(homedir(), '.akis', 'dev-sessions.json')) {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      if (Array.isArray(raw)) {
        // Tolerant hydrate: keep only rows that look like sessions — a hand-edited or
        // corrupted file never crashes the boot; bad rows are dropped.
        const sessions = raw.filter((s): s is SessionState =>
          !!s && typeof s === 'object'
          && typeof (s as SessionState).id === 'string'
          && typeof (s as SessionState).status === 'string'
          && typeof (s as SessionState).version === 'number')
        this.inner.hydrate(sessions)
      }
    } catch { /* first boot (no file yet) or unreadable — start empty */ }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(this.inner.snapshot(), null, 2), { mode: 0o600 })
      chmodSync(this.file, 0o600) // writeFileSync mode is umask-masked; chmod is unconditional
    } catch {
      if (!this.warned) {
        this.warned = true
        // eslint-disable-next-line no-console
        console.warn('store: dev-sessions file unwritable — builds will reset on restart (in-memory only)')
      }
    }
  }

  async create(s: SessionState): Promise<void> {
    await this.inner.create(s)
    this.persist()
  }
  async get(id: string): Promise<SessionState | undefined> { return this.inner.get(id) }
  async update(id: string, patch: SessionPatch, expectedVersion: number): Promise<SessionState> {
    const out = await this.inner.update(id, patch, expectedVersion)
    this.persist()
    return out
  }
  async recordApproval(id: string, approval: ApprovalToken, expectedVersion: number): Promise<SessionState> {
    const out = await this.inner.recordApproval(id, approval, expectedVersion)
    this.persist()
    return out
  }
  async recordVerification(id: string, token: VerifyToken, expectedVersion: number): Promise<SessionState> {
    const out = await this.inner.recordVerification(id, token, expectedVersion)
    this.persist()
    return out
  }
  async listByOwner(ownerId: string): Promise<SessionState[]> { return this.inner.listByOwner(ownerId) }
  async listSummariesByOwner(ownerId: string): Promise<SessionSummary[]> { return this.inner.listSummariesByOwner(ownerId) }
}
