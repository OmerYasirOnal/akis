import { describe, it, expect } from 'vitest'
import { STRINGS } from '../i18n/catalog.js'

/** Lockstep guard for the model-picker namespaces: EN and TR must carry IDENTICAL key sets
 *  for `chat.picker.*` and `chat.chip.*` (the effort labels live under chat.picker.effort.*).
 *  A missing TR key would already break tsc (StringKey is `as const`-derived); this also
 *  catches a typo'd / extra key at runtime and fails the build. */
describe('model-picker i18n lockstep', () => {
  const NS = ['chat.picker.', 'chat.chip.', 'chat.provider.']

  it('has symmetric EN/TR keys across the model-picker namespaces', () => {
    const en = Object.keys(STRINGS.en).filter(k => NS.some(p => k.startsWith(p))).sort()
    const tr = Object.keys(STRINGS.tr).filter(k => NS.some(p => k.startsWith(p))).sort()
    expect(en.length).toBeGreaterThan(0)
    expect(tr).toEqual(en)
  })

  it('includes the three effort labels in BOTH locales', () => {
    for (const e of ['fast', 'balanced', 'deep'] as const) {
      const key = `chat.picker.effort.${e}` as keyof typeof STRINGS['en']
      expect(STRINGS.en[key]).toBeTruthy()
      expect(STRINGS.tr[key]).toBeTruthy()
    }
  })

  it('resolves the LIVE/DEMO chip badges in EN and TR', () => {
    expect(STRINGS.en['chat.chip.live']).toBe('LIVE')
    expect(STRINGS.tr['chat.chip.live']).toBe('CANLI')
    expect(STRINGS.en['chat.chip.demo']).toBe('DEMO')
    expect(STRINGS.tr['chat.chip.demo']).toBe('DEMO')
  })
})
