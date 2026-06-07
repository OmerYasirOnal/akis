import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { encryptSecret, decryptSecret, masterKeyUsable, type EncryptedSecret } from './crypto.js'
import type { RemoteMcpAuthStore, RemoteMcpAuthRecord, RemoteMcpAuthPatch } from '../agent/mcp/StoreBackedOAuthProvider.js'

/** Per-(user,provider) AAD namespace — distinct from AI keys / GitHub-conn / Atlassian-conn, so MCP
 *  OAuth material can never be replayed under another store. The discriminator binds BOTH the
 *  provider AND the user (`<provider>:<userId>`), so a row can't be replayed across users either. */
const AAD_SCOPE = 'akis:mcp-conn:'

/** The persisted row: ONE AES-256-GCM blob holding the JSON {clientInfo, tokens, codeVerifier}
 *  record + a plaintext connectedAt timestamp (non-secret). Mirrors GitHub/Atlassian conn stores. */
interface StoredRow extends EncryptedSecret { connectedAt: string }

/**
 * Encrypted-at-rest, per-(user,provider) store for remote-MCP OAuth material — the production backing
 * for StoreBackedOAuthProvider (the DCR client info + the access/refresh tokens + the transient PKCE
 * verifier). Everything is held in ONE encrypted blob (the whole RemoteMcpAuthRecord), AAD-bound to
 * `<provider>:<userId>`. An undecryptable row (rotated/unset master, corrupt file) reads as ABSENT
 * (never throws) so the provider treats it as not-connected — fail-closed. Persisted 0600, restart-
 * durable. The tokens/client-secret never reach disk in plaintext and are never logged.
 */
export class JsonFileRemoteMcpAuthStore implements RemoteMcpAuthStore {
  private rows: Record<string, StoredRow>

  constructor(
    private filePath: string,
    private master: string,
    private now: () => string = () => new Date().toISOString(),
  ) {
    this.rows = this.read()
  }

  private key(userId: string, provider: string): string { return `${provider}:${userId}` }
  private disc(userId: string, provider: string): string { return `${provider}:${userId}` }

  private read(): Record<string, StoredRow> {
    if (!existsSync(this.filePath)) return {}
    try { return JSON.parse(readFileSync(this.filePath, 'utf8')) as Record<string, StoredRow> } catch { return {} }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 })
    writeFileSync(this.filePath, JSON.stringify(this.rows, null, 2), { mode: 0o600 })
  }

  load(userId: string, provider: string): RemoteMcpAuthRecord | undefined {
    const row = this.rows[this.key(userId, provider)]
    if (!row) return undefined
    // Undecryptable (rotated/unset master, corrupt) ⇒ ABSENT, never throw (the provider then treats
    // the connection as not-present and the user re-connects).
    try { return JSON.parse(decryptSecret(row, this.disc(userId, provider), this.master, AAD_SCOPE)) as RemoteMcpAuthRecord } catch { return undefined }
  }

  save(userId: string, provider: string, patch: RemoteMcpAuthPatch): void {
    const cur = this.load(userId, provider) ?? {}
    const next: RemoteMcpAuthRecord = { ...cur }
    // An explicit `undefined` CLEARS the field (invalidateCredentials); an absent key leaves it.
    if ('clientInfo' in patch) { if (patch.clientInfo === undefined) delete next.clientInfo; else next.clientInfo = patch.clientInfo }
    if ('tokens' in patch) { if (patch.tokens === undefined) delete next.tokens; else next.tokens = patch.tokens }
    if ('codeVerifier' in patch) { if (patch.codeVerifier === undefined) delete next.codeVerifier; else next.codeVerifier = patch.codeVerifier }
    const enc = encryptSecret(JSON.stringify(next), this.disc(userId, provider), this.master, 'v1', AAD_SCOPE)
    this.rows[this.key(userId, provider)] = { ...enc, connectedAt: this.now() }
    this.persist()
  }

  clearVerifier(userId: string, provider: string): void {
    this.save(userId, provider, { codeVerifier: undefined })
  }

  /** Remove a connection entirely (the disconnect route). */
  remove(userId: string, provider: string): void {
    delete this.rows[this.key(userId, provider)]
    this.persist()
  }

  canStore(): boolean { return masterKeyUsable(this.master) }
}
