import { describe, it, expect } from 'vitest'
import { createProvider, ProviderConfigError, hasRealProviderKey } from '../../src/agent/providers/createProvider.js'

describe('createProvider — fail-closed (X-AC6 / CF6)', () => {
  it('returns mock under NODE_ENV=test (the only implicit mock)', () => {
    expect(createProvider({ env: { NODE_ENV: 'test', ANTHROPIC_API_KEY: 'sk-ant-x' } }).name).toBe('mock')
    expect(createProvider({ env: { NODE_ENV: 'test' } }).name).toBe('mock')
  })
  it('returns mock when explicitly opted in (allowMock) outside test', () => {
    expect(createProvider({ env: { NODE_ENV: 'production' }, allowMock: true }).name).toBe('mock')
  })
  it('returns mock when provider is explicitly "mock"', () => {
    expect(createProvider({ provider: 'mock', env: { NODE_ENV: 'production' } }).name).toBe('mock')
    expect(createProvider({ env: { AI_PROVIDER: 'mock', NODE_ENV: 'production' } }).name).toBe('mock')
  })

  it('FAILS LOUDLY in production when no key/provider is configured (no silent mock)', () => {
    expect(() => createProvider({ env: { NODE_ENV: 'production' } })).toThrow(ProviderConfigError)
  })
  it('FAILS LOUDLY on an invalid AI_PROVIDER in production (no silent mock)', () => {
    expect(() => createProvider({ env: { AI_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'sk-ant-x', NODE_ENV: 'production' } })).toThrow(ProviderConfigError)
  })
  it('FAILS LOUDLY when a provider is forced but its key is absent', () => {
    expect(() => createProvider({ provider: 'anthropic', env: { NODE_ENV: 'production' } })).toThrow(ProviderConfigError)
  })

  it('builds anthropic when forced and a key is present (non-test)', () => {
    const p = createProvider({ provider: 'anthropic', env: { ANTHROPIC_API_KEY: 'sk-ant-x', NODE_ENV: 'production' } })
    expect(p.name).toBe('anthropic')
    expect(p.model).toBe('claude-haiku-4-5-20251001')
  })
  it('defaults to Anthropic (Claude) when ANTHROPIC_API_KEY is present and nothing else is set', () => {
    // CORE-AC2: live by default on Claude.
    const p = createProvider({ env: { ANTHROPIC_API_KEY: 'sk-ant-x', NODE_ENV: 'production' } })
    expect(p.name).toBe('anthropic')
  })
  it('honors the generic AI_PROVIDER + AI_API_KEY + AI_MODEL scheme (BYO .env)', () => {
    const p = createProvider({ env: { AI_PROVIDER: 'anthropic', AI_API_KEY: 'sk-ant-x', AI_MODEL: 'claude-opus-4-8', NODE_ENV: 'production' } })
    expect(p.name).toBe('anthropic')
    expect(p.model).toBe('claude-opus-4-8')
  })
  it('does NOT apply AI_API_KEY without a named provider (no wrong-provider key)', () => {
    expect(() => createProvider({ env: { AI_API_KEY: 'somekey', NODE_ENV: 'production' } })).toThrow(ProviderConfigError)
  })
  it('auto-detects provider from a present key (non-test)', () => {
    expect(createProvider({ env: { OPENAI_API_KEY: 'sk-proj-x', NODE_ENV: 'production' } }).name).toBe('openai')
    expect(createProvider({ env: { GEMINI_API_KEY: 'AIza-x', NODE_ENV: 'production' } }).name).toBe('google')
  })
  it('honors AI_MODEL override', () => {
    const p = createProvider({ provider: 'anthropic', model: 'claude-opus-4-8', env: { ANTHROPIC_API_KEY: 'sk-ant-x', NODE_ENV: 'production' } })
    expect(p.model).toBe('claude-opus-4-8')
  })
  it('consults the KeyStore after env when no env key is present', () => {
    const keyStore = { get: (p: string) => (p === 'anthropic' ? 'sk-ant-stored' : undefined) }
    const p = createProvider({ provider: 'anthropic', keyStore, env: { NODE_ENV: 'production' } })
    expect(p.name).toBe('anthropic')
  })
  it('AUTO-DETECTS the provider from the KeyStore when no env key and no forced provider (Settings-only key)', () => {
    // The Settings UI saves a key to the KeyStore with NO env var. hasRealProviderKey
    // counts it (so the mock is disabled), so createProvider MUST also resolve the
    // provider from the KeyStore — otherwise boot disables mock yet can't build a provider.
    const keyStore = { get: (p: string) => (p === 'anthropic' ? 'sk-ant-stored' : undefined) }
    const p = createProvider({ keyStore, env: { NODE_ENV: 'production' } })
    expect(p.name).toBe('anthropic')
  })
  it('stays consistent with hasRealProviderKey for a KeyStore-only key (no boot crash)', () => {
    const keyStore = { get: (p: string) => (p === 'openai' ? 'sk-proj-stored' : undefined) }
    const env = { NODE_ENV: 'production' }
    expect(hasRealProviderKey(env, keyStore)).toBe(true)
    expect(() => createProvider({ keyStore, env })).not.toThrow()
    expect(createProvider({ keyStore, env }).name).toBe('openai')
  })
  it('honors a base-URL override (does not crash; provider still builds)', () => {
    const p = createProvider({ provider: 'openai', env: { OPENAI_API_KEY: 'sk-proj-x', OPENAI_BASE_URL: 'https://proxy.example/v1', NODE_ENV: 'production' } })
    expect(p.name).toBe('openai')
  })
})

describe('hasRealProviderKey — keyless-demo gate (self-host AKIS_ALLOW_MOCK fallback)', () => {
  it('false when no provider key is configured anywhere', () => {
    expect(hasRealProviderKey({})).toBe(false)
    expect(hasRealProviderKey({ NODE_ENV: 'production' })).toBe(false)
  })
  it('true when a per-provider env key is present (auto-detected)', () => {
    expect(hasRealProviderKey({ ANTHROPIC_API_KEY: 'sk-ant-x' })).toBe(true)
    expect(hasRealProviderKey({ OPENAI_API_KEY: 'sk-proj-x' })).toBe(true)
    expect(hasRealProviderKey({ GEMINI_API_KEY: 'AIza-x' })).toBe(true)
  })
  it('true when AI_PROVIDER + AI_API_KEY (generic BYO) is set', () => {
    expect(hasRealProviderKey({ AI_PROVIDER: 'anthropic', AI_API_KEY: 'sk-ant-x' })).toBe(true)
  })
  it('false for a generic AI_API_KEY with NO named provider (cannot resolve a provider)', () => {
    expect(hasRealProviderKey({ AI_API_KEY: 'somekey' })).toBe(false)
  })
  it('true when a key lives only in the KeyStore', () => {
    const keyStore = { get: (p: string) => (p === 'anthropic' ? 'sk-ant-stored' : undefined) }
    expect(hasRealProviderKey({}, keyStore)).toBe(true)
  })
})
