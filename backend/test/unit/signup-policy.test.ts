import { describe, it, expect } from 'vitest'
import { resolveSignupDisabled } from '../../src/api/server.js'

/**
 * FAIL-CLOSED registration (strategy Move 1 — make the safety posture true BY CODE, not by a
 * network-edge block). AKIS runs generated code on the host with NO isolation boundary, so an
 * open-signup instance is RCE-for-anyone. A fresh self-host must therefore be CLOSED by default
 * in production; dev stays open for convenience; AKIS_DISABLE_SIGNUP forces it off anywhere.
 */
describe('resolveSignupDisabled — fail-closed registration policy', () => {
  it('production defaults to DISABLED (a fresh self-host is not open-signup)', () => {
    expect(resolveSignupDisabled({ NODE_ENV: 'production' })).toBe(true)
  })
  it('production + AKIS_ALLOW_SIGNUP=1 explicitly opts back in', () => {
    expect(resolveSignupDisabled({ NODE_ENV: 'production', AKIS_ALLOW_SIGNUP: '1' })).toBe(false)
  })
  it('development defaults to ENABLED (convenience)', () => {
    expect(resolveSignupDisabled({})).toBe(false)
    expect(resolveSignupDisabled({ NODE_ENV: 'development' })).toBe(false)
  })
  it('AKIS_DISABLE_SIGNUP forces it off in ANY environment', () => {
    expect(resolveSignupDisabled({ AKIS_DISABLE_SIGNUP: '1' })).toBe(true)
    expect(resolveSignupDisabled({ NODE_ENV: 'development', AKIS_DISABLE_SIGNUP: 'true' })).toBe(true)
  })
})
