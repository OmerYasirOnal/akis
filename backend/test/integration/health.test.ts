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
    // HTTP metrics: the counter fed by the onResponse hook. The snapshot reflects PRIOR requests
    // (this request's onResponse fires after reply.send), so total>0 comes from the signup + this GET.
    expect(typeof body.http.total).toBe('number')
    expect(body.http.total).toBeGreaterThan(0)
    expect(typeof body.http.errorRate).toBe('number')
    expect(typeof body.http.serverErrorRate).toBe('number')
    expect(typeof body.http.tooManyRequests).toBe('number')
  })

  it('http.errorRate + tooManyRequests reflect real 4xx/429 traffic; RAG metrics absent when RAG is off', async () => {
    const app = buildServer({ keyStore: keyStore(), env: { AUTH_JWT_SECRET: 'ops-secret' } })
    const cookie = cookieOf(await app.inject({ method: 'POST', url: '/auth/signup', payload: { name: 'Ada', email: 'ada@akis.dev', password: 'password1234' } }))
    // Generate a 4xx (unknown route) and a 401 (unauth ops) so the error counters move.
    await app.inject({ method: 'GET', url: '/nope-404' })
    await app.inject({ method: 'GET', url: '/api/ops' }) // 401
    const body = (await app.inject({ method: 'GET', url: '/api/ops', headers: { cookie } })).json()
    expect(body.http.clientError).toBeGreaterThan(0)
    expect(body.http.errorRate).toBeGreaterThan(0)
    // RAG is off by default (no AKIS_RAG) → the rag block is omitted, not an empty object.
    expect(body.rag).toBeUndefined()
  })

  it('surfaces RAG ingest/corpus health on /api/ops when RAG is on (AKIS_RAG=1)', async () => {
    const app = buildServer({ keyStore: keyStore(), env: { AUTH_JWT_SECRET: 'ops-secret', AKIS_RAG: '1' } })
    const cookie = cookieOf(await app.inject({ method: 'POST', url: '/auth/signup', payload: { name: 'Ada', email: 'ada@akis.dev', password: 'password1234' } }))
    const body = (await app.inject({ method: 'GET', url: '/api/ops', headers: { cookie } })).json()
    // RagService.getMetrics() → ingest counters + corpusSize, decoupled via the thunk.
    expect(body.rag).toBeDefined()
    expect(typeof body.rag.corpusSize).toBe('number')
    expect(typeof body.rag.ingested).toBe('number')
    expect(typeof body.rag.deadLettered).toBe('number')
    await app.close() // RAG-on wiring starts an ingest queue/timers — close so nothing leaks past the test
  })
})

describe('admin allowlist — /api/ops gating + /auth/me isAdmin', () => {
  it('NO allowlist (default): any authenticated user reaches /api/ops (byte-identical) and isAdmin is absent', async () => {
    const app = buildServer({ keyStore: keyStore(), env: { AUTH_JWT_SECRET: 'ops-secret' } })
    const signup = await app.inject({ method: 'POST', url: '/auth/signup', payload: { name: 'Ada', email: 'ada@akis.dev', password: 'password1234' } })
    expect(signup.json().user.isAdmin).toBeUndefined() // no allowlist → no derived flag
    const cookie = cookieOf(signup)
    expect((await app.inject({ method: 'GET', url: '/api/ops', headers: { cookie } })).statusCode).toBe(200)
  })

  it('allowlist SET: an allowlisted email is admin (isAdmin=true, /api/ops 200); a non-admin is refused 401', async () => {
    const env = { AUTH_JWT_SECRET: 'ops-secret', AKIS_ADMIN_EMAILS: 'boss@akis.dev' }
    const app = buildServer({ keyStore: keyStore(), env })
    // The admin.
    const adminCookie = cookieOf(await app.inject({ method: 'POST', url: '/auth/signup', payload: { name: 'Boss', email: 'boss@akis.dev', password: 'password1234' } }))
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: adminCookie } })
    expect(me.json().user.isAdmin).toBe(true)
    expect((await app.inject({ method: 'GET', url: '/api/ops', headers: { cookie: adminCookie } })).statusCode).toBe(200)
    // A non-admin authenticated user is refused the operator view (401), and isAdmin is absent.
    const userCookie = cookieOf(await app.inject({ method: 'POST', url: '/auth/signup', payload: { name: 'Mal', email: 'mal@akis.dev', password: 'password1234' } }))
    const userMe = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: userCookie } })
    expect(userMe.json().user.isAdmin).toBeUndefined()
    expect((await app.inject({ method: 'GET', url: '/api/ops', headers: { cookie: userCookie } })).statusCode).toBe(401)
  })

  it('AKIS_OWNER_EMAIL alone makes that user an admin (the single-owner is always an admin)', async () => {
    const app = buildServer({ keyStore: keyStore(), env: { AUTH_JWT_SECRET: 'ops-secret', AKIS_OWNER_EMAIL: 'owner@akis.dev' } })
    const ownerCookie = cookieOf(await app.inject({ method: 'POST', url: '/auth/signup', payload: { name: 'Own', email: 'owner@akis.dev', password: 'password1234' } }))
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: ownerCookie } })).json().user.isAdmin).toBe(true)
  })
})
