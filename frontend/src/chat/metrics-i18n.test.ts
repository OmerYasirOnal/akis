import { describe, it, expect } from 'vitest'
import { STRINGS } from '../i18n/catalog.js'

/**
 * Lockstep guard for the metrics namespaces: EN and TR must carry IDENTICAL key sets for
 * `metrics.*` and `analytics.perRun.*`. This is the ONLY guard that catches a missed TR
 * mirror — StringKey is `keyof STRINGS['en']` so TR is UNCONSTRAINED by tsc, and t() falls
 * back to English silently at runtime (a missing TR key ships EN-in-TR, no crash, no other
 * test failure). Modeled on model-picker-i18n.test.ts.
 */
describe('metrics i18n lockstep', () => {
  const NS = ['metrics.', 'analytics.perRun.']

  it('has symmetric EN/TR keys across the metrics namespaces', () => {
    const en = Object.keys(STRINGS.en).filter(k => NS.some(p => k.startsWith(p))).sort()
    const tr = Object.keys(STRINGS.tr).filter(k => NS.some(p => k.startsWith(p))).sort()
    expect(en.length).toBeGreaterThan(0)
    expect(tr).toEqual(en)
  })

  it('carries both the singular and plural tool labels in BOTH locales (no runtime fallback)', () => {
    for (const k of ['metrics.tool', 'metrics.tools'] as const) {
      expect(STRINGS.en[k]).toBeTruthy()
      expect(STRINGS.tr[k]).toBeTruthy()
    }
  })
})
