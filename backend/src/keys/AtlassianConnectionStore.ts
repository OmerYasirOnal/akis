import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { encryptSecret, decryptSecret, masterKeyUsable, type EncryptedSecret } from './crypto.js'

/** Atlassian-scoped AAD namespace — distinct from AI keys ('akis:ai-key:') and the GitHub
 *  connection ('akis:github-conn:'), so an Atlassian token can never be replayed under another
 *  store. The per-user id is the AAD discriminator within this namespace. */
const ATL_AAD_SCOPE = 'akis:atlassian-conn:'

/** PUBLIC projection — what status/UI sees. NEVER carries a token. */
export interface AtlassianConnection {
  /** The Atlassian Cloud site id (needed to address Jira/Confluence APIs). */
  cloudId: string
  /** The site base URL (e.g. https://your-org.atlassian.net) — display only. */
  siteUrl: string
  scopes: string[]
  connectedAt: string
  /** Access-token expiry (ISO). The route refreshes via the refresh token when near/after this. */
  expiresAt: string
}

/** What the connect/refresh flow hands the store. accessToken + refreshToken are the secrets
 *  (encrypted at rest together); the rest is non-secret metadata. */
export interface AtlassianConnectionInput {
  accessToken: string
  refreshToken: string
  cloudId: string
  siteUrl: string
  scopes: string[]
  /** Access-token lifetime in seconds (Atlassian returns expires_in ~3600). */
  expiresInSec: number
}

/** The decrypted token pair — returned only to the server-side refresh + write-execute paths. */
export interface AtlassianTokens { accessToken: string; refreshToken: string }

export interface AtlassianConnectionStore {
  set(userId: string, input: AtlassianConnectionInput): void
  /** Decrypted {access, refresh}, or undefined when absent OR undecryptable (never throws). */
  getTokens(userId: string): AtlassianTokens | undefined
  /** Non-secret projection (tokens excluded), or undefined when absent/undecryptable. */
  status(userId: string): AtlassianConnection | undefined
  remove(userId: string): void
  /** Whether a token CAN be stored right now (encryption configured) — non-throwing preflight. */
  canStore(): boolean
}

/** The persisted row: ONE encrypted blob holding {access,refresh} JSON + non-secret metadata in
 *  the clear (mirrors GitHubConnectionStore keeping username/repo in plaintext). */
interface StoredRow extends EncryptedSecret {
  cloudId: string
  siteUrl: string
  scopes: string[]
  connectedAt: string
  expiresAt: string
}

/** Encode the secret pair as ONE plaintext blob so a single AES-GCM row covers both tokens. */
function packTokens(t: AtlassianTokens): string { return JSON.stringify({ a: t.accessToken, r: t.refreshToken }) }
function unpackTokens(s: string): AtlassianTokens {
  const o = JSON.parse(s) as { a?: string; r?: string }
  // Fail-closed: a decrypted-but-incomplete blob must NOT advertise as connected with an empty
  // token — throw so getTokens()'s catch returns undefined (treated as absent), like the
  // undecryptable path. (Unreachable today — set() always packs both — but hardens the invariant.)
  if (!o.a || !o.r) throw new Error('atlassian-conn: incomplete token blob')
  return { accessToken: o.a, refreshToken: o.r }
}

/**
 * JSON-file per-user Atlassian connection store — a parallel to JsonFileGitHubConnectionStore.
 * The access+refresh tokens are AES-256-GCM encrypted at rest under the Atlassian-scoped AAD
 * ('akis:atlassian-conn:<userId>'), persisted 0600. status() exposes ONLY non-secret fields. The
 * tokens are stored ONLY here — never reused as a login/session credential. Survives restart.
 */
export class JsonFileAtlassianConnectionStore implements AtlassianConnectionStore {
  private rows: Record<string, StoredRow>

  constructor(
    private filePath: string,
    private master: string,
    private now: () => number = () => Date.now(),
  ) {
    this.rows = this.load()
  }

  private load(): Record<string, StoredRow> {
    if (!existsSync(this.filePath)) return {}
    try { return JSON.parse(readFileSync(this.filePath, 'utf8')) as Record<string, StoredRow> } catch { return {} }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 })
    writeFileSync(this.filePath, JSON.stringify(this.rows, null, 2), { mode: 0o600 })
  }

  set(userId: string, input: AtlassianConnectionInput): void {
    const enc = encryptSecret(packTokens({ accessToken: input.accessToken, refreshToken: input.refreshToken }), userId, this.master, 'v1', ATL_AAD_SCOPE)
    const nowMs = this.now()
    this.rows[userId] = {
      ...enc,
      cloudId: input.cloudId, siteUrl: input.siteUrl, scopes: input.scopes,
      connectedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + input.expiresInSec * 1000).toISOString(),
    }
    this.persist()
  }

  getTokens(userId: string): AtlassianTokens | undefined {
    const row = this.rows[userId]
    if (!row) return undefined
    // A row that can't be decrypted (rotated/unset master, corrupt file) is, for resolution
    // purposes, ABSENT — return undefined rather than throwing (mirrors GitHubConnectionStore).
    try { return unpackTokens(decryptSecret(row, userId, this.master, ATL_AAD_SCOPE)) } catch { return undefined }
  }

  status(userId: string): AtlassianConnection | undefined {
    const row = this.rows[userId]
    if (!row) return undefined
    // USABILITY, not mere presence: a row whose tokens no longer decrypt must NOT be advertised as
    // connected (else the UI shows a connection the write path can't use). Fail closed.
    if (this.getTokens(userId) === undefined) return undefined
    return { cloudId: row.cloudId, siteUrl: row.siteUrl, scopes: row.scopes, connectedAt: row.connectedAt, expiresAt: row.expiresAt }
  }

  remove(userId: string): void { delete this.rows[userId]; this.persist() }

  canStore(): boolean { return masterKeyUsable(this.master) }
}

/** In-memory store for tests + the host-injection default (no master). No encryption needed. */
export class AtlassianConnectionMemoryStore implements AtlassianConnectionStore {
  private rows = new Map<string, AtlassianTokens & AtlassianConnection>()

  constructor(private now: () => number = () => Date.now()) {}

  set(userId: string, input: AtlassianConnectionInput): void {
    const nowMs = this.now()
    this.rows.set(userId, {
      accessToken: input.accessToken, refreshToken: input.refreshToken,
      cloudId: input.cloudId, siteUrl: input.siteUrl, scopes: input.scopes,
      connectedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + input.expiresInSec * 1000).toISOString(),
    })
  }

  getTokens(userId: string): AtlassianTokens | undefined {
    const r = this.rows.get(userId)
    return r ? { accessToken: r.accessToken, refreshToken: r.refreshToken } : undefined
  }

  status(userId: string): AtlassianConnection | undefined {
    const r = this.rows.get(userId)
    if (!r) return undefined
    return { cloudId: r.cloudId, siteUrl: r.siteUrl, scopes: r.scopes, connectedAt: r.connectedAt, expiresAt: r.expiresAt }
  }

  remove(userId: string): void { this.rows.delete(userId) }

  canStore(): boolean { return true }
}
