import { describe, it, expect } from 'vitest'
import { buildServer, persistenceRequired, resolveDemoMode, demoModeFatalInProd } from '../../src/api/server.js'
import type { KeyStore } from '../../src/keys/KeyStore.js'

/**
 * Self-host durability contract: setting DATABASE_URL means "persist my data." In
 * production a set-but-unreachable DB must FAIL CLOSED (refuse to boot in-memory) rather
 * than silently lose users/sessions on the next restart; /health surfaces the active mode
 * so a degraded (dev) fallback is observable instead of looking healthy.
 */
const noKeyStore: KeyStore = { status: p => ({ provider: p, configured: false }), get: () => undefined, set: () => {}, remove: () => {}, list: () => [] }
const baseEnv = { AUTH_JWT_SECRET: 'test-secret' }

describe('persistenceRequired', () => {
  it('is true ONLY when NODE_ENV=production AND DATABASE_URL is set', () => {
    expect(persistenceRequired({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x/y' })).toBe(true)
    expect(persistenceRequired({ NODE_ENV: 'production' })).toBe(false)
    expect(persistenceRequired({ DATABASE_URL: 'postgres://x/y' })).toBe(false)
    expect(persistenceRequired({})).toBe(false)
  })
})

describe('resolveDemoMode (B1: demo fail-closed in prod)', () => {
  it('no demo flag → live, never fatal', () => {
    expect(resolveDemoMode({})).toEqual({ mode: 'live', fatal: false })
    expect(resolveDemoMode({ NODE_ENV: 'production' })).toEqual({ mode: 'live', fatal: false })
  })

  it('demo flag in NON-production → demo, allowed (not fatal)', () => {
    expect(resolveDemoMode({ AKIS_ALLOW_MOCK: '1' })).toEqual({ mode: 'demo', fatal: false })
    expect(resolveDemoMode({ AKIS_DEMO_VERIFY: '1' })).toEqual({ mode: 'demo', fatal: false })
    expect(resolveDemoMode({ NODE_ENV: 'development', AKIS_ALLOW_MOCK: 'true' })).toEqual({ mode: 'demo', fatal: false })
  })

  it('demo flag in production with NO ack → demo + FATAL', () => {
    expect(resolveDemoMode({ NODE_ENV: 'production', AKIS_ALLOW_MOCK: '1' })).toEqual({ mode: 'demo', fatal: true })
    expect(resolveDemoMode({ NODE_ENV: 'production', AKIS_DEMO_VERIFY: '1' })).toEqual({ mode: 'demo', fatal: true })
    expect(demoModeFatalInProd({ NODE_ENV: 'production', AKIS_ALLOW_MOCK: '1' })).toBe(true)
  })

  it('demo flag in production WITH explicit ack → demo, allowed-but-flagged (not fatal)', () => {
    expect(resolveDemoMode({ NODE_ENV: 'production', AKIS_ALLOW_MOCK: '1', AKIS_ALLOW_DEMO_IN_PROD: '1' }))
      .toEqual({ mode: 'demo', fatal: false })
    expect(demoModeFatalInProd({ NODE_ENV: 'production', AKIS_DEMO_VERIFY: '1', AKIS_ALLOW_DEMO_IN_PROD: '1' })).toBe(false)
  })
})

describe('buildServer demo fail-closed', () => {
  it('REFUSES to boot a production server with a demo flag and no acknowledgment', () => {
    expect(() => buildServer({ keyStore: noKeyStore, env: { ...baseEnv, NODE_ENV: 'production', AKIS_ALLOW_MOCK: '1' } }))
      .toThrow(/Refusing to boot|demo flag/)
  })

  it('boots (flagged demo) in production when the operator acknowledges with AKIS_ALLOW_DEMO_IN_PROD', async () => {
    const app = buildServer({ keyStore: noKeyStore, env: { ...baseEnv, NODE_ENV: 'production', AKIS_ALLOW_MOCK: '1', AKIS_ALLOW_DEMO_IN_PROD: '1', AUTH_JWT_SECRET: 'prod-secret' } })
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.json()).toMatchObject({ ok: true, mode: 'demo' })
  })

  it('boots normally (live) in dev with no demo flag', async () => {
    const app = buildServer({ keyStore: noKeyStore, env: baseEnv })
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.json()).toMatchObject({ ok: true, mode: 'live' })
  })
})

describe('GET /health persistence + serving mode', () => {
  it('reports the in-memory store and live mode by default', async () => {
    const app = buildServer({ keyStore: noKeyStore, env: baseEnv })
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, persistence: 'memory', mode: 'live' })
  })

  it('reports postgres when durable stores are active', async () => {
    const app = buildServer({ keyStore: noKeyStore, env: baseEnv, persistence: 'postgres' })
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.json()).toMatchObject({ ok: true, persistence: 'postgres' })
  })

  it('reports demo mode when a demo flag is active (dev keyless demo)', async () => {
    const app = buildServer({ keyStore: noKeyStore, env: { ...baseEnv, AKIS_ALLOW_MOCK: '1' } })
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.json()).toMatchObject({ ok: true, mode: 'demo' })
  })
})
