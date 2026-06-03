import { describe, it, expect } from 'vitest'
import { encryptSecret, decryptSecret } from '../../src/keys/crypto.js'

const MASTER = '0'.repeat(64) // 32 bytes hex

// Flip the low bit of the first byte of a base64 blob, returning fresh base64.
// Simulates an at-rest corruption/tamper of cipherText or authTag.
function flipFirstByte(b64: string): string {
  const buf = Buffer.from(b64, 'base64')
  buf.writeUInt8(buf.readUInt8(0) ^ 0x01, 0)
  return buf.toString('base64')
}

describe('crypto', () => {
  it('round-trips a secret bound to a provider AAD', () => {
    const enc = encryptSecret('sk-ant-secret', 'anthropic', MASTER)
    expect(enc.cipherText).not.toContain('secret')
    expect(enc.keyVersion).toBe('v1')
    expect(decryptSecret(enc, 'anthropic', MASTER)).toBe('sk-ant-secret')
  })
  it('rejects decryption under a different provider AAD', () => {
    const enc = encryptSecret('sk-ant-secret', 'anthropic', MASTER)
    expect(() => decryptSecret(enc, 'openai', MASTER)).toThrow()
  })
  it('rejects a tampered cipherText (GCM auth tag catches corruption, not just AAD)', () => {
    const enc = encryptSecret('sk-ant-secret', 'anthropic', MASTER)
    const tampered = { ...enc, cipherText: flipFirstByte(enc.cipherText) }
    expect(() => decryptSecret(tampered, 'anthropic', MASTER)).toThrow()
  })
  it('rejects a tampered authTag (integrity tag must be verified on decrypt)', () => {
    const enc = encryptSecret('sk-ant-secret', 'anthropic', MASTER)
    const tampered = { ...enc, authTag: flipFirstByte(enc.authTag) }
    expect(() => decryptSecret(tampered, 'anthropic', MASTER)).toThrow()
  })
  it('accepts a base64 master key', () => {
    const b64 = Buffer.alloc(32, 7).toString('base64')
    const enc = encryptSecret('x', 'openai', b64)
    expect(decryptSecret(enc, 'openai', b64)).toBe('x')
  })
  it('throws when master key is missing/wrong length', () => {
    expect(() => encryptSecret('x', 'openai', '')).toThrow()
    expect(() => encryptSecret('x', 'openai', 'short')).toThrow()
  })
  it('uses a fresh random IV per encrypt (no nonce reuse — catastrophic for GCM)', () => {
    const a = encryptSecret('same-secret', 'anthropic', MASTER)
    const b = encryptSecret('same-secret', 'anthropic', MASTER)
    expect(a.iv).not.toBe(b.iv)
    expect(a.cipherText).not.toBe(b.cipherText)
    expect(Buffer.from(a.iv, 'base64').length).toBe(12)
  })
})
