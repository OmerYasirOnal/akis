import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { encryptSecret, decryptSecret, masterKeyUsable, type EncryptedSecret } from './crypto.js'

/** The publish-scoped AAD namespace — distinct from AI provider keys ('akis:ai-key:') AND the
 *  GitHub connection store ('akis:github-conn:'), so a stored SSH key can never be replayed under
 *  another store (and vice versa). The per-user id is the AAD discriminator within this namespace. */
const PUBLISH_AAD_SCOPE = 'akis:publish:'

/** PUBLIC projection of a publish destination — what status/UI sees. NEVER carries the SSH key.
 *  Only non-secret metadata + the key FINGERPRINT (a stable hint, not the key). */
export interface PublishProfileStatus {
  host: string
  sshUser: string
  targetDir: string
  appPort?: number
  publicUrl?: string
  /** SHA256(PEM-bytes) base64 — a stable hint to confirm WHICH key is stored, never the key
   *  itself. The ONLY derived hint: no key length/prefix is stored (those leak structure). */
  keyFingerprint: string
  updatedAt: string
}

/** What the route hands the store. `sshPrivateKey` is the ONLY secret field; it is encrypted at
 *  rest, never returned by status, never logged. The non-secret fields are stored in the clear. */
export interface PublishProfileInput {
  host: string
  sshUser: string
  /** The PEM-encoded private SSH key — encrypted at rest under 'akis:publish:<userId>'. */
  sshPrivateKey: string
  targetDir: string
  appPort?: number
  publicUrl?: string
}

/** The decrypted profile the publisher consumes (includes the transient plaintext key). */
export interface PublishProfile {
  host: string
  sshUser: string
  sshPrivateKey: string
  targetDir: string
  appPort?: number
  publicUrl?: string
}

export interface PublishProfileStore {
  set(userId: string, input: PublishProfileInput): void
  /** The decrypted profile (incl. the plaintext key), or undefined when absent OR undecryptable
   *  (never throws — a rotated/unset master reads as no-profile, fail-closed). */
  getProfile(userId: string): PublishProfile | undefined
  /** The non-secret projection (key excluded), or undefined when absent/undecryptable. */
  status(userId: string): PublishProfileStatus | undefined
  remove(userId: string): void
  /** Whether a key CAN be stored right now (encryption configured). A non-throwing preflight
   *  so the PUT route never accepts a key it can't persist (encryptSecret would throw). */
  canStore(): boolean
}

/** SHA256(PEM-bytes) base64 — the stable, key-free fingerprint surfaced by status(). Computed
 *  over the EXACT bytes the user pasted (no normalization) so the same paste always matches. */
export function keyFingerprint(pem: string): string {
  return createHash('sha256').update(pem, 'utf8').digest('base64')
}

/** The persisted row: the encrypted key + non-secret metadata in plaintext (mirrors
 *  JsonFileGitHubConnectionStore keeping repo/connectedAt in the clear — only the SECRET
 *  is encrypted). `keyFingerprint` is a derived non-secret hint, stored in the clear. */
interface StoredRow extends EncryptedSecret {
  host: string
  sshUser: string
  targetDir: string
  appPort?: number
  publicUrl?: string
  keyFingerprint: string
  updatedAt: string
}

/**
 * JSON-file per-user publish-destination store — a byte-for-byte parallel to
 * JsonFileGitHubConnectionStore. The SSH private key is AES-256-GCM encrypted at rest under the
 * publish-scoped AAD ('akis:publish:<userId>'), persisted 0600. status() exposes ONLY non-secret
 * fields + the key fingerprint, NEVER the key or ciphertext. Survives restart via the file.
 *
 * The key is stored ONLY here — it is NEVER reused as a login/session credential, and this store
 * has no access to the user/session machinery.
 */
export class JsonFilePublishProfileStore implements PublishProfileStore {
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
    // 0600: owner read/write only — the file holds an encrypted SSH key + metadata.
    writeFileSync(this.filePath, JSON.stringify(this.rows, null, 2), { mode: 0o600 })
  }

  set(userId: string, input: PublishProfileInput): void {
    const enc = encryptSecret(input.sshPrivateKey, userId, this.master, 'v1', PUBLISH_AAD_SCOPE)
    // exactOptionalPropertyTypes: spread optionals conditionally (never store an explicit undefined).
    this.rows[userId] = {
      ...enc,
      host: input.host,
      sshUser: input.sshUser,
      targetDir: input.targetDir,
      ...(input.appPort !== undefined ? { appPort: input.appPort } : {}),
      ...(input.publicUrl !== undefined ? { publicUrl: input.publicUrl } : {}),
      keyFingerprint: keyFingerprint(input.sshPrivateKey),
      updatedAt: this.now(),
    }
    this.persist()
  }

  getProfile(userId: string): PublishProfile | undefined {
    const row = this.rows[userId]
    if (!row) return undefined
    // A row that can't be decrypted — rotated/unset AI_KEY_ENCRYPTION_KEY, or a corrupt/
    // partially-restored file — is, for resolution purposes, ABSENT. Return undefined rather
    // than throwing: an unguarded throw here would surface inside the publish route.
    let key: string
    try {
      key = decryptSecret(row, userId, this.master, PUBLISH_AAD_SCOPE)
    } catch {
      return undefined
    }
    return {
      host: row.host,
      sshUser: row.sshUser,
      sshPrivateKey: key,
      targetDir: row.targetDir,
      ...(row.appPort !== undefined ? { appPort: row.appPort } : {}),
      ...(row.publicUrl !== undefined ? { publicUrl: row.publicUrl } : {}),
    }
  }

  status(userId: string): PublishProfileStatus | undefined {
    const row = this.rows[userId]
    if (!row) return undefined
    // USABILITY, not mere presence: a row whose key no longer decrypts (master rotated/unset)
    // must NOT be advertised as configured, or the FE shows a destination publish can't use.
    // Fail closed to "no profile" (mirrors GitHubConnectionStore.status).
    if (this.getProfile(userId) === undefined) return undefined
    return {
      host: row.host,
      sshUser: row.sshUser,
      targetDir: row.targetDir,
      ...(row.appPort !== undefined ? { appPort: row.appPort } : {}),
      ...(row.publicUrl !== undefined ? { publicUrl: row.publicUrl } : {}),
      keyFingerprint: row.keyFingerprint,
      updatedAt: row.updatedAt,
    }
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
 * No encryption is needed (nothing leaves the process), so canStore() is always true. The
 * fingerprint is still computed so status() carries the same key-free hint as the file store.
 */
export class PublishProfileMemoryStore implements PublishProfileStore {
  private rows = new Map<string, PublishProfile & { keyFingerprint: string; updatedAt: string }>()

  constructor(private now: () => string = () => new Date().toISOString()) {}

  set(userId: string, input: PublishProfileInput): void {
    this.rows.set(userId, {
      host: input.host,
      sshUser: input.sshUser,
      sshPrivateKey: input.sshPrivateKey,
      targetDir: input.targetDir,
      ...(input.appPort !== undefined ? { appPort: input.appPort } : {}),
      ...(input.publicUrl !== undefined ? { publicUrl: input.publicUrl } : {}),
      keyFingerprint: keyFingerprint(input.sshPrivateKey),
      updatedAt: this.now(),
    })
  }

  getProfile(userId: string): PublishProfile | undefined {
    const r = this.rows.get(userId)
    if (!r) return undefined
    return {
      host: r.host,
      sshUser: r.sshUser,
      sshPrivateKey: r.sshPrivateKey,
      targetDir: r.targetDir,
      ...(r.appPort !== undefined ? { appPort: r.appPort } : {}),
      ...(r.publicUrl !== undefined ? { publicUrl: r.publicUrl } : {}),
    }
  }

  status(userId: string): PublishProfileStatus | undefined {
    const r = this.rows.get(userId)
    if (!r) return undefined
    return {
      host: r.host,
      sshUser: r.sshUser,
      targetDir: r.targetDir,
      ...(r.appPort !== undefined ? { appPort: r.appPort } : {}),
      ...(r.publicUrl !== undefined ? { publicUrl: r.publicUrl } : {}),
      keyFingerprint: r.keyFingerprint,
      updatedAt: r.updatedAt,
    }
  }

  remove(userId: string): void {
    this.rows.delete(userId)
  }

  canStore(): boolean {
    return true
  }
}
