import { describe, it, expect } from 'vitest'
import { STRINGS } from '../i18n/catalog.js'

/**
 * Lockstep guard for the account namespace (NFR-account-menu-9 / provider-badge NFR-9): EN and
 * TR must carry IDENTICAL key sets for `account.*` — INCLUDING the three `account.via.*` provider
 * lines the AccountMenu badge renders. StringKey is `keyof STRINGS['en']`, so TR is UNCONSTRAINED
 * by tsc and t() falls back to English silently at runtime — a dropped TR mirror would ship
 * English-in-Turkish with no crash and no other failing test. This is the only guard that catches
 * it. Modeled on metrics-i18n.test.ts.
 */
describe('account i18n lockstep', () => {
  const NS = 'account.'

  it('has symmetric EN/TR keys across the account namespace', () => {
    const en = Object.keys(STRINGS.en).filter(k => k.startsWith(NS)).sort()
    const tr = Object.keys(STRINGS.tr).filter(k => k.startsWith(NS)).sort()
    expect(en.length).toBeGreaterThan(0)
    expect(tr).toEqual(en)
  })

  it('carries all three account.via.* provider lines in BOTH locales (no runtime EN fallback)', () => {
    for (const k of ['account.via.github', 'account.via.google', 'account.via.password'] as const) {
      expect(STRINGS.en[k]).toBeTruthy()
      expect(STRINGS.tr[k]).toBeTruthy()
      // The TR copy must be its OWN string, not the English value leaking through.
      expect(STRINGS.tr[k]).not.toBe(STRINGS.en[k])
    }
  })

  it('carries the account.menuLabel (the trigger/menu aria-label) in BOTH locales', () => {
    expect(STRINGS.en['account.menuLabel']).toBeTruthy()
    expect(STRINGS.tr['account.menuLabel']).toBeTruthy()
  })
})
