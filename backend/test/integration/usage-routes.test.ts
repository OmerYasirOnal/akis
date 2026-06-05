import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildServer } from '../../src/api/server.js'
import { JsonFileKeyStore } from '../../src/keys/KeyStore.js'
import { UsageStore } from '../../src/usage/UsageStore.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MASTER = '0'.repeat(64)
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'akis-usage-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const keyStore = () => new JsonFileKeyStore(join(dir, 'keys.json'), MASTER, () => '2026-06-01T00:00:00Z')
const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie']).split(';')[0]

describe('GET /api/usage', () => {
  it('authenticated ⇒ {usedTokens,budget,remaining,resetAt}', async () => {
    const usage = new UsageStore({ periodMs: 30 * 24 * 60 * 60 * 1000 })
    const app = buildServer({ keyStore: keyStore(), usage, env: { AUTH_JWT_SECRET: 'usage-secret', AKIS_USER_TOKEN_BUDGET: '1000' } })
    const cookie = cookieOf(await app.inject({ method: 'POST', url: '/auth/signup', payload: { name: 'Ada', email: 'ada@akis.dev', password: 'password1234' } }))
    // Seed some usage for the authenticated owner id.
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })
    const ownerId = me.json().user.id as string
    await usage.add(ownerId, 250)

    const res = await app.inject({ method: 'GET', url: '/api/usage', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ usedTokens: 250, budget: 1000, remaining: 750 })
    expect(typeof res.json().resetAt).toBe('string')
  })

  it('unauthenticated ⇒ 401', async () => {
    const app = buildServer({ keyStore: keyStore(), env: { AUTH_JWT_SECRET: 'usage-secret', AKIS_USER_TOKEN_BUDGET: '1000' } })
    const res = await app.inject({ method: 'GET', url: '/api/usage' })
    expect(res.statusCode).toBe(401)
  })

  it('budget unset (unlimited) ⇒ remaining -1 sentinel + budget 0', async () => {
    const app = buildServer({ keyStore: keyStore(), env: { AUTH_JWT_SECRET: 'usage-secret' } }) // no budget
    const cookie = cookieOf(await app.inject({ method: 'POST', url: '/auth/signup', payload: { name: 'Bo', email: 'bo@akis.dev', password: 'password1234' } }))
    const res = await app.inject({ method: 'GET', url: '/api/usage', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ budget: 0, remaining: -1, resetAt: '' })
  })
})
