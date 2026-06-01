import { describe, it, expect } from 'vitest'
import { createProvider } from '../../src/agent/providers/createProvider.js'

describe('createProvider', () => {
  it('falls back to mock when no key is configured', () => {
    expect(createProvider({ env: {} }).name).toBe('mock')
  })
  it('falls back to mock when NODE_ENV=test even if a key is present', () => {
    expect(createProvider({ env: { NODE_ENV: 'test', ANTHROPIC_API_KEY: 'sk-ant-x' } }).name).toBe('mock')
  })
  it('builds anthropic when forced and a key is present (non-test)', () => {
    const p = createProvider({ provider: 'anthropic', env: { ANTHROPIC_API_KEY: 'sk-ant-x', NODE_ENV: 'production' } })
    expect(p.name).toBe('anthropic')
    expect(p.model).toBe('claude-haiku-4-5-20251001')
  })
  it('auto-detects provider from a present key (non-test)', () => {
    expect(createProvider({ env: { OPENAI_API_KEY: 'sk-proj-x', NODE_ENV: 'production' } }).name).toBe('openai')
    expect(createProvider({ env: { GEMINI_API_KEY: 'AIza-x', NODE_ENV: 'production' } }).name).toBe('google')
  })
  it('honors AI_MODEL override', () => {
    const p = createProvider({ provider: 'anthropic', model: 'claude-opus-4-8', env: { ANTHROPIC_API_KEY: 'sk-ant-x', NODE_ENV: 'production' } })
    expect(p.model).toBe('claude-opus-4-8')
  })
  it('fails safe to mock on an invalid AI_PROVIDER (no crash)', () => {
    expect(createProvider({ env: { AI_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'sk-ant-x', NODE_ENV: 'production' } }).name).toBe('mock')
  })
  it('consults the KeyStore after env when no env key is present', () => {
    const keyStore = { get: (p: string) => (p === 'anthropic' ? 'sk-ant-stored' : undefined) }
    const p = createProvider({ provider: 'anthropic', keyStore, env: { NODE_ENV: 'production' } })
    expect(p.name).toBe('anthropic')
  })
  it('honors a base-URL override (does not crash; provider still builds)', () => {
    const p = createProvider({ provider: 'openai', env: { OPENAI_API_KEY: 'sk-proj-x', OPENAI_BASE_URL: 'https://proxy.example/v1', NODE_ENV: 'production' } })
    expect(p.name).toBe('openai')
  })
})
