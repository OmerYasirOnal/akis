import { describe, it, expect } from 'vitest'
import { encryptSecret, decryptSecret } from '../../src/keys/crypto.js'

const MASTER = '0'.repeat(64) // 32 bytes hex

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
