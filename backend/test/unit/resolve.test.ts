import { describe, it, expect } from 'vitest'
import { detectProviderFromKey, resolveModel } from '../../src/agent/providers/resolve.js'

describe('resolve', () => {
  it('detects provider from key prefix (sk-ant before sk-)', () => {
    expect(detectProviderFromKey('sk-ant-abc')).toBe('anthropic')
    expect(detectProviderFromKey('AIzaSyXXX')).toBe('google')
    expect(detectProviderFromKey('sk-or-xyz')).toBe('openrouter')
    expect(detectProviderFromKey('sk-proj-xyz')).toBe('openai')
    expect(detectProviderFromKey('sk-abc')).toBe('openai')
    expect(detectProviderFromKey('whatever')).toBeUndefined()
  })
  it('resolves the catalog default model when none given', () => {
    expect(resolveModel('anthropic', undefined)).toBe('claude-haiku-4-5-20251001')
    expect(resolveModel('anthropic', 'claude-opus-4-8')).toBe('claude-opus-4-8')
    expect(resolveModel('google', undefined)).toBe('gemini-2.5-flash')
  })
})
