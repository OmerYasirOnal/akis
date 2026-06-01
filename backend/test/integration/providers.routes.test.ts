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
  return buildServer({ keyStore, env })
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

  it('PUT stores a key (last4 only, never echoes), GET then shows available, DELETE removes', async () => {
    const a = app()
    const put = await a.inject({ method: 'PUT', url: '/api/providers/anthropic/key', payload: { apiKey: 'sk-ant-12345' } })
    expect(put.statusCode).toBe(200)
    expect(put.json().last4).toBe('2345')
    expect(JSON.stringify(put.json())).not.toContain('sk-ant-12345')

    const after = (await a.inject({ method: 'GET', url: '/api/providers' })).json()
    expect(after.find((p: { id: string }) => p.id === 'anthropic').available).toBe(true)

    const del = await a.inject({ method: 'DELETE', url: '/api/providers/anthropic/key' })
    expect(del.statusCode).toBe(200)
  })

  it('rejects an unknown provider and an empty key', async () => {
    const a = app()
    expect((await a.inject({ method: 'PUT', url: '/api/providers/nope/key', payload: { apiKey: 'x' } })).statusCode).toBe(400)
    expect((await a.inject({ method: 'PUT', url: '/api/providers/anthropic/key', payload: { apiKey: '  ' } })).statusCode).toBe(400)
  })
})
