import { describe, it, expect, beforeEach } from 'vitest'
import { loadModelPref, saveModelPref, defaultModelPref, MODEL_PREF_KEY } from './modelPref.js'

beforeEach(() => localStorage.clear())

describe('modelPref — chat-only model preference persistence', () => {
  it('returns the default (AKIS default, balanced) when nothing is saved', () => {
    expect(loadModelPref()).toEqual({ provider: '', model: '', effort: 'balanced' })
    expect(defaultModelPref()).toEqual({ provider: '', model: '', effort: 'balanced' })
  })

  it('round-trips a saved preference through localStorage', () => {
    saveModelPref({ provider: 'anthropic', model: 'claude-sonnet-4-6', effort: 'deep' })
    expect(localStorage.getItem(MODEL_PREF_KEY)).toBeTruthy()
    expect(loadModelPref()).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6', effort: 'deep' })
  })

  it('falls back to the default on CORRUPT JSON (never throws)', () => {
    localStorage.setItem(MODEL_PREF_KEY, 'not-valid-json{')
    expect(() => loadModelPref()).not.toThrow()
    expect(loadModelPref()).toEqual(defaultModelPref())
  })

  it('coerces a malformed shape: bad effort → balanced, non-string fields → empty', () => {
    localStorage.setItem(MODEL_PREF_KEY, JSON.stringify({ provider: 42, model: null, effort: 'turbo' }))
    expect(loadModelPref()).toEqual({ provider: '', model: '', effort: 'balanced' })
  })

  it('preserves a valid effort across all three tiers', () => {
    for (const effort of ['fast', 'balanced', 'deep'] as const) {
      saveModelPref({ provider: 'openai', model: 'gpt-4.1-mini', effort })
      expect(loadModelPref().effort).toBe(effort)
    }
  })
})
