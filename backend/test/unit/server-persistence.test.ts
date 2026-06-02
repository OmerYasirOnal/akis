import { describe, it, expect } from 'vitest'
import { buildServer, persistenceRequired } from '../../src/api/server.js'
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

describe('GET /health persistence mode', () => {
  it('reports the in-memory store by default', async () => {
    const app = buildServer({ keyStore: noKeyStore, env: baseEnv })
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, persistence: 'memory' })
  })

  it('reports postgres when durable stores are active', async () => {
    const app = buildServer({ keyStore: noKeyStore, env: baseEnv, persistence: 'postgres' })
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.json()).toMatchObject({ ok: true, persistence: 'postgres' })
  })
})
