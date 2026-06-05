import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * AES-256-GCM encryption for API keys at rest. The ciphertext is bound to its
 * provider via a scoped AAD (`akis:ai-key:<provider>`), so a stored row cannot be
 * replayed under a different provider. The master key comes from env (hex64 or
 * base64). Plaintext exists only transiently in memory during encrypt/decrypt.
 */
export interface EncryptedSecret {
  cipherText: string // base64
  iv: string // base64
  authTag: string // base64
  keyVersion: string
}

export class EncryptionNotConfiguredError extends Error {
  constructor() { super('AI key encryption not configured (set AI_KEY_ENCRYPTION_KEY)'); this.name = 'EncryptionNotConfiguredError' }
}

function parseMasterKey(master: string): Buffer {
  if (!master) throw new EncryptionNotConfiguredError()
  // 64 hex chars → 32 bytes; else try base64.
  if (/^[0-9a-fA-F]{64}$/.test(master)) return Buffer.from(master, 'hex')
  const b = Buffer.from(master, 'base64')
  if (b.length !== 32) throw new Error('AI_KEY_ENCRYPTION_KEY must decode to 32 bytes (hex64 or base64)')
  return b
}

/** The default AAD namespace for AI provider keys. A SECOND store (the per-user GitHub
 *  connection store) reuses this same crypto under its OWN namespace ('akis:github-conn:')
 *  so the two secret kinds can never be replayed across stores. */
const DEFAULT_AAD_SCOPE = 'akis:ai-key:'

function aad(provider: string, scope: string = DEFAULT_AAD_SCOPE): Buffer {
  return Buffer.from(`${scope}${provider}`)
}

/** Encrypt a secret. `aadScope` DEFAULTS to the AI-key namespace so provider-key crypto is
 *  byte-identical to before; a different namespace (e.g. 'akis:github-conn:') binds the row
 *  to a different store so a ciphertext can never be replayed across stores. */
export function encryptSecret(plaintext: string, provider: string, master: string, keyVersion = 'v1', aadScope: string = DEFAULT_AAD_SCOPE): EncryptedSecret {
  const key = parseMasterKey(master)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad(provider, aadScope))
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return {
    cipherText: enc.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    keyVersion,
  }
}

export function decryptSecret(enc: EncryptedSecret, provider: string, master: string, aadScope: string = DEFAULT_AAD_SCOPE): string {
  const key = parseMasterKey(master)
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(enc.iv, 'base64'))
  decipher.setAAD(aad(provider, aadScope))
  decipher.setAuthTag(Buffer.from(enc.authTag, 'base64'))
  const dec = Buffer.concat([decipher.update(Buffer.from(enc.cipherText, 'base64')), decipher.final()])
  return dec.toString('utf8')
}

/** A NON-THROWING probe of master-key usability — mirrors parseMasterKey's accept rule
 *  (hex64 OR base64 decoding to 32 bytes) WITHOUT throwing. The connect route preflights
 *  this so it never mints a GitHub authorization that then can't be encrypted at storage
 *  time (encryptSecret throws on an empty/invalid master). parseMasterKey's throwing
 *  contract is unchanged. */
export function masterKeyUsable(master: string): boolean {
  if (!master) return false
  if (/^[0-9a-fA-F]{64}$/.test(master)) return true
  return Buffer.from(master, 'base64').length === 32
}
