import { describe, it, expect } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer, persistenceRequired, resolveDemoMode, demoModeFatalInProd, demoRunnerEnabled } from '../../src/api/server.js'
import type { KeyStore } from '../../src/keys/KeyStore.js'
import { MockSessionStore } from '../../src/store/MockSessionStore.js'
import { initialSession } from '@akis/shared'
import type { AkisEvent } from '@akis/shared'
import type { OrchestratorServices } from '../../src/di/services.js'

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

describe('demoRunnerEnabled (audit #43: AKIS_REAL_TESTS overrides a demo flag)', () => {
  it('a demo flag alone enables the mock test runner', () => {
    expect(demoRunnerEnabled({ AKIS_ALLOW_MOCK: '1' })).toBe(true)
    expect(demoRunnerEnabled({ AKIS_DEMO_VERIFY: '1' })).toBe(true)
  })
  it('AKIS_REAL_TESTS OVERRIDES the demo flag → mock runner NOT injected (real verification wins)', () => {
    expect(demoRunnerEnabled({ AKIS_ALLOW_MOCK: '1', AKIS_REAL_TESTS: '1' })).toBe(false)
    expect(demoRunnerEnabled({ AKIS_DEMO_VERIFY: '1', AKIS_REAL_TESTS: '1' })).toBe(false)
  })
  it('no demo flag → no mock runner', () => {
    expect(demoRunnerEnabled({})).toBe(false)
    expect(demoRunnerEnabled({ AKIS_REAL_TESTS: '1' })).toBe(false)
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

describe('P1-CORE-1: preview_status carries the demo annotation', () => {
  // A static app (just an index.html) goes ready INSTANTLY — no install, no spawn — so the
  // registry's onStatus fires synchronously and we can assert the emitted preview_status.
  const staticCode = { files: [{ filePath: 'index.html', content: '<!doctype html><title>x</title>' }] }

  async function emitPreview(env: Record<string, string | undefined>): Promise<AkisEvent[]> {
    const store = new MockSessionStore()
    await store.create({ ...initialSession('s1', 'idea'), status: 'awaiting_push_confirm', code: staticCode })
    const app = buildServer({ keyStore: noKeyStore, env, sessionStore: store })
    const seen: AkisEvent[] = []
    ;(app as FastifyInstance & { akisServices: OrchestratorServices }).akisServices.bus.subscribe('s1', e => seen.push(e))
    await app.inject({ method: 'POST', url: '/sessions/s1/preview' })
    await app.close()
    return seen.filter(e => e.kind === 'preview_status')
  }

  it('stamps preview_status with demo:true in demo mode', async () => {
    const statuses = await emitPreview({ ...baseEnv, AKIS_ALLOW_MOCK: '1' })
    expect(statuses.length).toBeGreaterThan(0)
    expect(statuses.every(e => e.kind === 'preview_status' && e.demo === true)).toBe(true)
  })

  it('omits demo on preview_status in live mode (byte-identical)', async () => {
    const statuses = await emitPreview(baseEnv)
    expect(statuses.length).toBeGreaterThan(0)
    expect(statuses.every(e => e.kind === 'preview_status' && e.demo === undefined)).toBe(true)
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
