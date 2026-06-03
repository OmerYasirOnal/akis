import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { encryptSecret, decryptSecret, type EncryptedSecret } from './crypto.js'

export interface KeyStatus {
  provider: string
  configured: boolean
  last4?: string
  updatedAt?: string
}

export interface KeyStore {
  set(provider: string, apiKey: string): void
  get(provider: string): string | undefined
  remove(provider: string): void
  status(provider: string): KeyStatus
  list(): KeyStatus[]
}

interface StoredRow extends EncryptedSecret {
  last4: string
  updatedAt: string
}

/**
 * JSON-file key store. Keys are AES-256-GCM encrypted at rest (scoped per
 * provider). `status`/`list` expose ONLY non-secret fields (configured + last4 +
 * updatedAt) — never the key or ciphertext. Survives restart via the file.
 *
 * Honest note: timestamps are passed in by the caller (the route handler), since
 * Date.now() is unavailable in some execution contexts; default is undefined.
 */
export class JsonFileKeyStore implements KeyStore {
  private rows: Record<string, StoredRow>

  constructor(
    private filePath: string,
    private master: string,
    private now: () => string = () => new Date().toISOString(),
  ) {
    this.rows = this.load()
  }

  private load(): Record<string, StoredRow> {
    if (!existsSync(this.filePath)) return {}
    try {
      return JSON.parse(readFileSync(this.filePath, 'utf8')) as Record<string, StoredRow>
    } catch {
      return {}
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 })
    // 0600: owner read/write only — the file holds encrypted keys + metadata.
    writeFileSync(this.filePath, JSON.stringify(this.rows, null, 2), { mode: 0o600 })
  }

  set(provider: string, apiKey: string): void {
    const enc = encryptSecret(apiKey, provider, this.master)
    this.rows[provider] = { ...enc, last4: apiKey.slice(-4), updatedAt: this.now() }
    this.persist()
  }

  get(provider: string): string | undefined {
    const row = this.rows[provider]
    if (!row) return undefined
    // A row that can't be decrypted — rotated/unset AI_KEY_ENCRYPTION_KEY, or a corrupt/
    // partially-restored keys.json — is, for resolution purposes, ABSENT. Return undefined
    // rather than throwing: an unguarded throw here propagates through hasRealProviderKey /
    // createProvider into an unrecoverable server BOOT crash-loop (an opaque crypto error,
    // not a graceful "no provider" fallback).
    try {
      return decryptSecret(row, provider, this.master)
    } catch {
      return undefined
    }
  }

  remove(provider: string): void {
    delete this.rows[provider]
    this.persist()
  }

  status(provider: string): KeyStatus {
    const row = this.rows[provider]
    if (!row) return { provider, configured: false }
    // `configured` reflects USABILITY, not mere presence: a row that no longer decrypts
    // (master rotated/unset) must NOT be advertised as configured, or /api/providers
    // reports a key that createProvider can't actually build (a split-brain).
    if (this.get(provider) === undefined) return { provider, configured: false }
    return { provider, configured: true, last4: row.last4, updatedAt: row.updatedAt }
  }

  list(): KeyStatus[] {
    return Object.keys(this.rows).map(p => this.status(p))
  }
}
