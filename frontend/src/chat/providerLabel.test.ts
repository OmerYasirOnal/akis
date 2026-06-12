import { describe, it, expect } from 'vitest'
import { providerLabel } from './providerLabel.js'

describe('providerLabel — slug → display label (P1-5)', () => {
  it('maps each known provider slug to its catalog label', () => {
    expect(providerLabel('anthropic')).toBe('Anthropic (Claude)')
    expect(providerLabel('openai')).toBe('OpenAI')
    expect(providerLabel('google')).toBe('Google (Gemini)')
    expect(providerLabel('openrouter')).toBe('OpenRouter')
  })
  it('maps the mock slug to "Demo" (never the raw "mock")', () => {
    expect(providerLabel('mock')).toBe('Demo')
  })
  it('passes an UNKNOWN slug through as-is (no crash, never blank)', () => {
    expect(providerLabel('some-future-provider')).toBe('some-future-provider')
    expect(providerLabel('')).toBe('')
  })
})
