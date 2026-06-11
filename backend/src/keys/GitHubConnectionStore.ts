import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { encryptSecret, decryptSecret, masterKeyUsable, type EncryptedSecret } from './crypto.js'

/** The GitHub-scoped AAD namespace — distinct from AI provider keys ('akis:ai-key:'),
 *  so a stored GitHub token can never be replayed under the AI-key store (and vice versa).
 *  The per-user id is the AAD discriminator within this namespace. */
const GH_AAD_SCOPE = 'akis:github-conn:'

/** PUBLIC projection of a connection — what status/UI sees. NEVER carries the access token. */
export interface GitHubConnection {
  username: string
  scopes: string[]
  /**
   * A2.1 — DEAD on new connections. Connecting GitHub now ONLY authenticates (token + login); the
   * push target is PER-PROJECT (session.delivery, derived from the project title into the user's
   * PERSONAL namespace = `username`). This field is preserved for OLD rows written before A2.1 and
   * surfaced by status() only so they round-trip, but it is NEVER consulted for destination
   * resolution anymore (buildUserAdapter reads session.delivery, not this). Absent on new connects.
   */
  repo?: string
  connectedAt: string
}

/** What the connect callback hands the store. The accessToken is the ONLY secret field;
 *  it is encrypted at rest, never returned by status, never logged. `username` is the authed
 *  GitHub LOGIN (the personal namespace per-project repos are created under). A2.1: `repo` is
 *  no longer collected at connect time (token-only connect) — it stays optional for back-compat. */
export interface GitHubConnectionInput {
  accessToken: string
  username: string
  scopes: string[]
  repo?: string
}

export interface GitHubConnectionStore {
  set(userId: string, input: GitHubConnectionInput): void
  /** The decrypted access token, or undefined when absent OR undecryptable (never throws). */
  getToken(userId: string): string | undefined
  /** The non-secret projection (token excluded), or undefined when absent/undecryptable. */
  status(userId: string): GitHubConnection | undefined
  remove(userId: string): void
  /** Whether a token CAN be stored right now (encryption configured). A non-throwing
   *  preflight so the connect route never mints a GitHub authorization it can't persist. */
  canStore(): boolean
}

/** The persisted row: the encrypted token + non-secret metadata in plaintext (mirrors
 *  JsonFileKeyStore keeping last4/updatedAt in the clear — only the SECRET is encrypted). */
interface StoredRow extends EncryptedSecret {
  username: string
  scopes: string[]
  // A2.1: written only by OLD connections; new connects omit it (token-only). Optional, never read
  // for destination resolution anymore.
  repo?: string
  connectedAt: string
}

/**
 * JSON-file per-user GitHub connection store — a parallel to JsonFileKeyStore. The access
 * token is AES-256-GCM encrypted at rest under the GitHub-scoped AAD ('akis:github-conn:<userId>'),
 * persisted 0600. status() exposes ONLY non-secret fields (username/repo/scopes/connectedAt),
 * never the token or ciphertext. Survives restart via the file.
 *
 * The connect token is stored ONLY here — it is NEVER reused as a login/session credential,
 * and this store has no access to the user/session machinery.
 */
export class JsonFileGitHubConnectionStore implements GitHubConnectionStore {
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
    // 0600: owner read/write only — the file holds an encrypted token + metadata.
    writeFileSync(this.filePath, JSON.stringify(this.rows, null, 2), { mode: 0o600 })
  }

  set(userId: string, input: GitHubConnectionInput): void {
    const enc = encryptSecret(input.accessToken, userId, this.master, 'v1', GH_AAD_SCOPE)
    // A2.1: `repo` is conditionally spread (token-only connect omits it; exactOptionalPropertyTypes
    // forbids assigning `undefined` to the now-optional field). A re-connect REPLACES the row, so
    // an old connection's stale `repo` is naturally dropped on the next connect.
    this.rows[userId] = { ...enc, username: input.username, scopes: input.scopes, ...(input.repo ? { repo: input.repo } : {}), connectedAt: this.now() }
    this.persist()
  }

  getToken(userId: string): string | undefined {
    const row = this.rows[userId]
    if (!row) return undefined
    // A row that can't be decrypted — rotated/unset AI_KEY_ENCRYPTION_KEY, or a corrupt/
    // partially-restored file — is, for resolution purposes, ABSENT. Return undefined
    // rather than throwing: an unguarded throw here would surface inside confirmPush's
    // per-user adapter resolution and could break the (otherwise unchanged) push path.
    try {
      return decryptSecret(row, userId, this.master, GH_AAD_SCOPE)
    } catch {
      return undefined
    }
  }

  status(userId: string): GitHubConnection | undefined {
    const row = this.rows[userId]
    if (!row) return undefined
    // USABILITY, not mere presence: a row whose token no longer decrypts (master rotated/
    // unset) must NOT be advertised as connected, or the FE shows a connection the push
    // path can't actually use (a split-brain). Fail closed to "not connected".
    if (this.getToken(userId) === undefined) return undefined
    // A2.1: surface a legacy `repo` only if present (round-trip old rows); never required for new ones.
    return { username: row.username, scopes: row.scopes, ...(row.repo ? { repo: row.repo } : {}), connectedAt: row.connectedAt }
  }

  remove(userId: string): void {
    delete this.rows[userId]
    this.persist()
  }

  canStore(): boolean {
    return masterKeyUsable(this.master)
  }
}

/**
 * In-memory store for tests + the host-injection default (and any boot without a master).
 * No encryption is needed (nothing leaves the process), so canStore() is always true.
 */
export class GitHubConnectionMemoryStore implements GitHubConnectionStore {
  private rows = new Map<string, { token: string } & GitHubConnection>()

  constructor(private now: () => string = () => new Date().toISOString()) {}

  set(userId: string, input: GitHubConnectionInput): void {
    // A2.1: `repo` conditionally spread (token-only connect); a re-connect replaces the row.
    this.rows.set(userId, { token: input.accessToken, username: input.username, scopes: input.scopes, ...(input.repo ? { repo: input.repo } : {}), connectedAt: this.now() })
  }

  getToken(userId: string): string | undefined {
    return this.rows.get(userId)?.token
  }

  status(userId: string): GitHubConnection | undefined {
    const r = this.rows.get(userId)
    if (!r) return undefined
    return { username: r.username, scopes: r.scopes, ...(r.repo ? { repo: r.repo } : {}), connectedAt: r.connectedAt }
  }

  remove(userId: string): void {
    this.rows.delete(userId)
  }

  canStore(): boolean {
    return true
  }
}
