import { describe, it, expect } from 'vitest'
import { STRINGS } from '../i18n/catalog.js'

/** Guards F2-AC11: every workflows.* string exists in BOTH locales with no drift, and a
 *  spot-check resolves to the expected TR/EN copy. (StringKey is `as const`-derived, so a
 *  missing tr key already fails tsc — this also catches an extra/typo'd key at runtime.) */
describe('workflows i18n catalogue', () => {
  it('has identical key sets across en and tr', () => {
    const en = Object.keys(STRINGS.en).sort()
    const tr = Object.keys(STRINGS.tr).sort()
    expect(tr).toEqual(en)
  })

  it('includes the workflows.* namespace in both locales', () => {
    const enWf = Object.keys(STRINGS.en).filter(k => k.startsWith('workflows.'))
    expect(enWf.length).toBeGreaterThan(0)
    for (const k of enWf) {
      expect(STRINGS.tr[k as keyof typeof STRINGS['tr']]).toBeTruthy()
    }
  })

  it('resolves the page title in EN and TR', () => {
    expect(STRINGS.en['workflows.title']).toBe('Workflows')
    expect(STRINGS.tr['workflows.title']).toBe('İş Akışları')
  })
})
