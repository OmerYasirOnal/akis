import { describe, it, expect } from 'vitest'
import { STRINGS } from './catalog.js'

/**
 * NFR-oauth-signin-12 — EN/TR lockstep for the `auth.oauth.*` namespace (the social sign-in
 * button labels + the per-code callback-error messages surfaced from ?error=…).
 *
 * StringKey is `keyof STRINGS['en']`, so TR is UNCONSTRAINED by tsc and t() silently falls back to
 * English at runtime — a missed TR mirror ships EN-in-TR with no crash and no compile error. This
 * parity test is the only guard that catches a one-locale key add. Modeled on publish-i18n.test.ts.
 */
describe('auth.oauth.* i18n lockstep', () => {
  const NS = 'auth.oauth.'

  it('EN and TR carry an IDENTICAL auth.oauth.* key subset', () => {
    const en = Object.keys(STRINGS.en).filter(k => k.startsWith(NS)).sort()
    const tr = Object.keys(STRINGS.tr).filter(k => k.startsWith(NS)).sort()
    expect(en.length).toBeGreaterThan(0)
    expect(tr).toEqual(en)
  })

  it('carries every per-code callback-error message in BOTH locales (no runtime EN fallback)', () => {
    for (const k of [
      'auth.oauth.github', 'auth.oauth.google', 'auth.oauth.error',
      'auth.oauth.err.denied', 'auth.oauth.err.unavailable',
      'auth.oauth.err.state', 'auth.oauth.err.failed', 'auth.oauth.err.unknown',
    ] as const) {
      expect(STRINGS.en[k]).toBeTruthy()
      expect((STRINGS.tr as Record<string, string>)[k]).toBeTruthy()
    }
  })
})
