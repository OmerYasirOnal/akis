import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildServer } from '../../src/api/server.js'
import { JsonFileKeyStore } from '../../src/keys/KeyStore.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MASTER = '0'.repeat(64)
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'akis-health-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const keyStore = () => new JsonFileKeyStore(join(dir, 'keys.json'), MASTER, () => '2026-06-01T00:00:00Z')
const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie']).split(';')[0]

describe('GET /health — enriched operational signals', () => {
  it('includes uptimeSec, memory.rssMb/heapUsedMb, activeSessions, livePreviews, db', async () => {
    const app = buildServer({ keyStore: keyStore() })
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.ok).toBe(true)
    expect(typeof body.uptimeSec).toBe('number')
    expect(typeof body.memory.rssMb).toBe('number')
    expect(typeof body.memory.heapUsedMb).toBe('number')
    expect(body.activeSessions).toBe(0)
    expect(body.livePreviews).toBe(0)
    expect(body.db).toBe('off') // no DATABASE_URL / no dbPing injected
    // The original fields are unchanged.
    expect(body.persistence).toBe('memory')
    expect(body.mode).toBe('live')
  })

  it("db:'off' when no dbPing; db:'degraded' when injected dbPing rejects/false; ok stays true", async () => {
    const off = buildServer({ keyStore: keyStore() })
    expect((await off.inject({ method: 'GET', url: '/health' })).json().db).toBe('off')

    const degraded = buildServer({ keyStore: keyStore(), dbPing: async () => false })
    const dres = await degraded.inject({ method: 'GET', url: '/health' })
    expect(dres.json().db).toBe('degraded')
    expect(dres.json().ok).toBe(true) // the HTTP server is healthy even on a degraded DB

    const throwing = buildServer({ keyStore: keyStore(), dbPing: async () => { throw new Error('down') } })
    expect((await throwing.inject({ method: 'GET', url: '/health' })).json().db).toBe('degraded')

    const ok = buildServer({ keyStore: keyStore(), dbPing: async () => true })
    expect((await ok.inject({ method: 'GET', url: '/health' })).json().db).toBe('ok')
  })
})

describe('GET /api/ops — operator view', () => {
  it('authenticated ⇒ stats snapshot + ops block; unauthenticated ⇒ 401', async () => {
    const app = buildServer({ keyStore: keyStore(), env: { AUTH_JWT_SECRET: 'ops-secret' }, dbPing: async () => true })
    expect((await app.inject({ method: 'GET', url: '/api/ops' })).statusCode).toBe(401)

    const cookie = cookieOf(await app.inject({ method: 'POST', url: '/auth/signup', payload: { name: 'Ada', email: 'ada@akis.dev', password: 'password1234' } }))
    const res = await app.inject({ method: 'GET', url: '/api/ops', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    // The full StatsCollector snapshot fields.
    expect(typeof body.sessions).toBe('number')
    expect(Array.isArray(body.agents)).toBe(true)
    // The operational block.
    expect(typeof body.ops.uptimeSec).toBe('number')
    expect(typeof body.ops.memory.rssMb).toBe('number')
    expect(body.ops.db).toBe('ok')
    expect(body.ops.livePreviews).toBe(0)
  })
})
