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

function aad(provider: string): Buffer {
  return Buffer.from(`akis:ai-key:${provider}`)
}

export function encryptSecret(plaintext: string, provider: string, master: string, keyVersion = 'v1'): EncryptedSecret {
  const key = parseMasterKey(master)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad(provider))
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return {
    cipherText: enc.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    keyVersion,
  }
}

export function decryptSecret(enc: EncryptedSecret, provider: string, master: string): string {
  const key = parseMasterKey(master)
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(enc.iv, 'base64'))
  decipher.setAAD(aad(provider))
  decipher.setAuthTag(Buffer.from(enc.authTag, 'base64'))
  const dec = Buffer.concat([decipher.update(Buffer.from(enc.cipherText, 'base64')), decipher.final()])
  return dec.toString('utf8')
}
