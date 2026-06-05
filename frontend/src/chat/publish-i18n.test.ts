import { describe, it, expect } from 'vitest'
import { STRINGS } from '../i18n/catalog.js'

/**
 * Lockstep guard for the publish namespaces: EN and TR must carry IDENTICAL key sets for
 * `settings.publish.*` and `publish.*`. This is the ONLY guard that catches a missed TR mirror —
 * StringKey is `keyof STRINGS['en']` so TR is UNCONSTRAINED by tsc, and t() falls back to English
 * silently at runtime (a missing TR key ships EN-in-TR, no crash). Modeled on metrics-i18n.test.ts.
 */
describe('publish i18n lockstep', () => {
  const NS = ['settings.publish.', 'publish.']

  it('has symmetric EN/TR keys across the publish namespaces', () => {
    const en = Object.keys(STRINGS.en).filter(k => NS.some(p => k.startsWith(p))).sort()
    const tr = Object.keys(STRINGS.tr).filter(k => NS.some(p => k.startsWith(p))).sort()
    expect(en.length).toBeGreaterThan(0)
    expect(tr).toEqual(en)
  })

  it('carries the reachable-caution + not-configured strings in BOTH locales (no runtime fallback)', () => {
    for (const k of ['publish.unreachable', 'publish.notConfigured', 'settings.publish.notConfigured'] as const) {
      expect(STRINGS.en[k]).toBeTruthy()
      expect(STRINGS.tr[k]).toBeTruthy()
    }
  })
})
