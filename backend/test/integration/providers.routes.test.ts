import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildServer } from '../../src/api/server.js'
import { JsonFileKeyStore } from '../../src/keys/KeyStore.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MASTER = '0'.repeat(64)
let dir: string

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'akis-srv-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function app(env: Record<string, string | undefined> = {}) {
  const keyStore = new JsonFileKeyStore(join(dir, 'keys.json'), MASTER, () => '2026-06-01T00:00:00Z')
  return buildServer({ keyStore, env: { AUTH_JWT_SECRET: 'providers-test-secret', ...env } })
}

/** Sign up to obtain a session cookie (provider-key writes require auth). */
async function authCookie(server: ReturnType<typeof app>): Promise<string> {
  const res = await server.inject({ method: 'POST', url: '/auth/signup', payload: { name: 'Op', email: 'op@akis.dev', password: 'operator1234' } })
  return (res.headers['set-cookie'] as string).split(';')[0]!
}

describe('provider endpoints', () => {
  it('GET /api/providers lists catalog + availability', async () => {
    const res = await app().inject({ method: 'GET', url: '/api/providers' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body.find((p: { id: string }) => p.id === 'anthropic')).toBeTruthy()
    expect(body.every((p: { available: boolean }) => p.available === false)).toBe(true) // no keys
  })

  it('reports available=true when an env key is present', async () => {
    const res = await app({ ANTHROPIC_API_KEY: 'sk-ant-x' }).inject({ method: 'GET', url: '/api/providers' })
    expect(res.json().find((p: { id: string }) => p.id === 'anthropic').available).toBe(true)
  })

  it('reports available=true under the GENERIC AI_API_KEY fallback (the chip must not show NO KEY while real builds run on it)', async () => {
    const res = await app({ AI_API_KEY: 'sk-generic-x' }).inject({ method: 'GET', url: '/api/providers' })
    // createProvider resolves AI_API_KEY as the key for the selected real provider, so the chip
    // must report it available — otherwise the UI says "NO KEY" while the server builds for real.
    expect(res.json().find((p: { id: string }) => p.id === 'anthropic').available).toBe(true)
  })

  it('PUT stores a key (last4 only, never echoes), GET then shows available, DELETE removes', async () => {
    const a = app(); const cookie = await authCookie(a)
    const put = await a.inject({ method: 'PUT', url: '/api/providers/anthropic/key', payload: { apiKey: 'sk-ant-12345' }, headers: { cookie } })
    expect(put.statusCode).toBe(200)
    expect(put.json().last4).toBe('2345')
    expect(JSON.stringify(put.json())).not.toContain('sk-ant-12345')

    const after = (await a.inject({ method: 'GET', url: '/api/providers' })).json()
    expect(after.find((p: { id: string }) => p.id === 'anthropic').available).toBe(true)

    const del = await a.inject({ method: 'DELETE', url: '/api/providers/anthropic/key', headers: { cookie } })
    expect(del.statusCode).toBe(200)
  })

  it('requires authentication to write a provider key (401 without a session)', async () => {
    const a = app()
    expect((await a.inject({ method: 'PUT', url: '/api/providers/anthropic/key', payload: { apiKey: 'sk-ant-x' } })).statusCode).toBe(401)
    expect((await a.inject({ method: 'DELETE', url: '/api/providers/anthropic/key' })).statusCode).toBe(401)
  })

  it('rejects an unknown provider and an empty key', async () => {
    const a = app(); const cookie = await authCookie(a)
    expect((await a.inject({ method: 'PUT', url: '/api/providers/nope/key', payload: { apiKey: 'x' }, headers: { cookie } })).statusCode).toBe(400)
    expect((await a.inject({ method: 'PUT', url: '/api/providers/anthropic/key', payload: { apiKey: '  ' }, headers: { cookie } })).statusCode).toBe(400)
  })

  it('GET never leaks the full stored key (only last4)', async () => {
    const a = app(); const cookie = await authCookie(a)
    await a.inject({ method: 'PUT', url: '/api/providers/anthropic/key', payload: { apiKey: 'sk-ant-SUPERSECRET-9999' }, headers: { cookie } })
    const body = (await a.inject({ method: 'GET', url: '/api/providers' })).body
    expect(body).not.toContain('SUPERSECRET')
    expect(body).toContain('9999') // last4 only
  })
})
