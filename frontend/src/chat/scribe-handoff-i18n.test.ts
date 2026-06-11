import { describe, it, expect } from 'vitest'
import { STRINGS } from '../i18n/catalog.js'

/**
 * F1(b)/F3 i18n lockstep: the Scribe-handoff UX strings must carry IDENTICAL key sets in EN and TR.
 * StringKey is `keyof STRINGS['en']` so TR is UNCONSTRAINED by tsc, and t() falls back to English
 * silently at runtime — so a missed TR mirror would ship EN-in-TR with no crash and no other test
 * failure. Modeled on metrics-i18n.test.ts. The two keys:
 *  - chat.scribe.drafting     — the live "Scribe is drafting…" status (replaces the generic cue)
 *  - chat.agent.scribeFromChat — the run-block caption for the metrics-less synthetic Scribe stage
 */
describe('Scribe-handoff i18n lockstep (F1(b)/F3)', () => {
  const KEYS = ['chat.scribe.drafting', 'chat.agent.scribeFromChat'] as const

  it('every key is present + non-empty in BOTH locales (no silent EN-in-TR fallback)', () => {
    for (const k of KEYS) {
      expect(STRINGS.en[k], `EN ${k}`).toBeTruthy()
      expect((STRINGS.tr as Record<string, string>)[k], `TR ${k}`).toBeTruthy()
    }
  })

  it('TR is a DISTINCT translation (not the EN string copied across)', () => {
    for (const k of KEYS) {
      expect((STRINGS.tr as Record<string, string>)[k]).not.toBe(STRINGS.en[k])
    }
  })
})
