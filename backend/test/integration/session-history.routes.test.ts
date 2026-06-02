import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildServer } from '../../src/api/server.js'
import { JsonFileKeyStore } from '../../src/keys/KeyStore.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MASTER = '0'.repeat(64)
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'akis-hist-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

// Default services (mock provider under NODE_ENV=test); AUTH_JWT_SECRET for sessions.
const app = () => buildServer({ keyStore: new JsonFileKeyStore(join(dir, 'keys.json'), MASTER, () => '2026-06-01T00:00:00Z'), env: { AUTH_JWT_SECRET: 'hist-secret' } })
const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie']).split(';')[0]
const signup = (s: ReturnType<typeof app>, email: string) =>
  s.inject({ method: 'POST', url: '/auth/signup', payload: { name: 'U', email, password: 'password1234' } })

describe('per-user build history', () => {
  it('GET /sessions/mine requires auth', async () => {
    expect((await app().inject({ method: 'GET', url: '/sessions/mine' })).statusCode).toBe(401)
  })

  it('a build started while authed appears in that user\'s history only', async () => {
    const s = app()
    const ada = cookieOf(await signup(s, 'ada@akis.dev'))
    const bo = cookieOf(await signup(s, 'bo@akis.dev'))

    const created = await s.inject({ method: 'POST', url: '/sessions', payload: { idea: 'a todo app' }, headers: { cookie: ada } })
    expect(created.statusCode).toBe(201)
    expect(created.json().ownerId).toBeTruthy()

    const adaHist = await s.inject({ method: 'GET', url: '/sessions/mine', headers: { cookie: ada } })
    expect(adaHist.statusCode).toBe(200)
    expect(adaHist.json()).toHaveLength(1)
    expect(adaHist.json()[0]).toMatchObject({ idea: 'a todo app', id: created.json().id })

    // Bo sees none of Ada's builds.
    expect((await s.inject({ method: 'GET', url: '/sessions/mine', headers: { cookie: bo } })).json()).toEqual([])
  })
})
