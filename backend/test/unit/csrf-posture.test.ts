import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { csrfPostureWarning } from '../../src/api/csrfPosture.js'
import { buildServer } from '../../src/api/server.js'
import { JsonFileKeyStore } from '../../src/keys/KeyStore.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'akis-csrf-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
const keyStore = () => new JsonFileKeyStore(join(dir, 'keys.json'), '0'.repeat(64), () => '2026-06-01T00:00:00Z')

/**
 * The session cookie defaults to SameSite=Lax, which alone blocks the CSRF vector (the cookie is
 * NOT sent on a cross-site state-changing request). The Origin-check hook is defence-in-depth on
 * top, effective only when PUBLIC_BASE_URL is set. The ONE genuinely-unprotected combo is
 * SameSite=None (no SameSite protection) WITH no PUBLIC_BASE_URL (no Origin check) — surface it.
 */
describe('csrfPostureWarning', () => {
  afterEach(() => vi.restoreAllMocks())

  it('returns a warning ONLY for SameSite=None + no trusted origin (the unprotected combo)', () => {
    expect(csrfPostureWarning('none', undefined)).toMatch(/SameSite=None/)
    expect(csrfPostureWarning('none', '')).toMatch(/SameSite=None/)
  })

  it('is silent for the safe combos (Lax/Strict protect regardless; None+trustedOrigin is covered by the Origin check)', () => {
    expect(csrfPostureWarning('lax', undefined)).toBeUndefined()
    expect(csrfPostureWarning('strict', undefined)).toBeUndefined()
    expect(csrfPostureWarning('lax', 'https://app.example.com')).toBeUndefined()
    expect(csrfPostureWarning('none', 'https://app.example.com')).toBeUndefined()
  })

  it('buildServer emits the boot warning for SameSite=None + no PUBLIC_BASE_URL, and stays silent for the Lax default', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    buildServer({ keyStore: keyStore(), env: { AUTH_JWT_SECRET: 'x', AUTH_COOKIE_SAMESITE: 'none', AUTH_COOKIE_SECURE: 'true' } })
    expect(warn.mock.calls.some(c => String(c[0]).includes('SameSite=None'))).toBe(true)
    warn.mockClear()
    buildServer({ keyStore: keyStore(), env: { AUTH_JWT_SECRET: 'x' } }) // default SameSite=lax, no PUBLIC_BASE_URL
    expect(warn.mock.calls.some(c => String(c[0]).includes('SameSite=None'))).toBe(false)
  })
})
