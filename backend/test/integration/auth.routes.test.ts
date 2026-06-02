import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildServer } from '../../src/api/server.js'
import { JsonFileKeyStore } from '../../src/keys/KeyStore.js'
import { UserStore } from '../../src/auth/UserStore.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MASTER = '0'.repeat(64)
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'akis-auth-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function app(userStore = new UserStore()) {
  const keyStore = new JsonFileKeyStore(join(dir, 'keys.json'), MASTER, () => '2026-06-01T00:00:00Z')
  return buildServer({ keyStore, env: { AUTH_JWT_SECRET: 'integration-secret' }, userStore })
}

/** Pull the session cookie value back out of a Set-Cookie header for the next request. */
function sessionCookie(res: { headers: Record<string, unknown> }): string {
  const sc = res.headers['set-cookie']
  const raw = Array.isArray(sc) ? sc[0] : (sc as string)
  return raw.split(';')[0] // "akis_session=<token>"
}

describe('auth routes', () => {
  it('signup → sets an httpOnly cookie and returns the public user (no hash)', async () => {
    const res = await app().inject({ method: 'POST', url: '/auth/signup', payload: { name: 'Ada', email: 'ada@akis.dev', password: 'hunter2hunter' } })
    expect(res.statusCode).toBe(201)
    expect(res.json().user).toMatchObject({ name: 'Ada', email: 'ada@akis.dev' })
    expect(res.json().user).not.toHaveProperty('passwordHash')
    const sc = res.headers['set-cookie'] as string
    expect(String(sc)).toContain('HttpOnly')
  })

  it('signup then /auth/me with the cookie returns the user', async () => {
    const server = app()
    const signup = await server.inject({ method: 'POST', url: '/auth/signup', payload: { name: 'Ada', email: 'ada@akis.dev', password: 'hunter2hunter' } })
    const me = await server.inject({ method: 'GET', url: '/auth/me', headers: { cookie: sessionCookie(signup) } })
    expect(me.statusCode).toBe(200)
    expect(me.json().user.email).toBe('ada@akis.dev')
  })

  it('/auth/me without a cookie is 401', async () => {
    const res = await app().inject({ method: 'GET', url: '/auth/me' })
    expect(res.statusCode).toBe(401)
  })

  it('rejects duplicate email with 409', async () => {
    const server = app()
    const body = { name: 'Ada', email: 'dup@akis.dev', password: 'hunter2hunter' }
    await server.inject({ method: 'POST', url: '/auth/signup', payload: body })
    const second = await server.inject({ method: 'POST', url: '/auth/signup', payload: body })
    expect(second.statusCode).toBe(409)
    expect(second.json().code).toBe('EmailTaken')
  })

  it('rejects a weak password with 400', async () => {
    const res = await app().inject({ method: 'POST', url: '/auth/signup', payload: { name: 'Ada', email: 'ada@akis.dev', password: 'short' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('WeakPassword')
  })

  it('login with correct creds succeeds; wrong password is 401 (no enumeration)', async () => {
    const store = new UserStore()
    const server = app(store)
    await server.inject({ method: 'POST', url: '/auth/signup', payload: { name: 'Ada', email: 'ada@akis.dev', password: 'hunter2hunter' } })
    const ok = await server.inject({ method: 'POST', url: '/auth/login', payload: { email: 'ada@akis.dev', password: 'hunter2hunter' } })
    expect(ok.statusCode).toBe(200)
    const bad = await server.inject({ method: 'POST', url: '/auth/login', payload: { email: 'ada@akis.dev', password: 'nope-nope-nope' } })
    expect(bad.statusCode).toBe(401)
    const unknown = await server.inject({ method: 'POST', url: '/auth/login', payload: { email: 'ghost@akis.dev', password: 'whatever12' } })
    expect(unknown.statusCode).toBe(401)
    expect(bad.json().error).toBe(unknown.json().error) // identical → no account enumeration
  })

  it('logout clears the cookie (Max-Age=0) so /auth/me is 401 after', async () => {
    const res = await app().inject({ method: 'POST', url: '/auth/logout' })
    expect(res.statusCode).toBe(200)
    expect(String(res.headers['set-cookie'])).toContain('Max-Age=0')
  })

  it('a forged/garbage cookie does not authenticate (401)', async () => {
    const res = await app().inject({ method: 'GET', url: '/auth/me', headers: { cookie: 'akis_session=not.a.jwt' } })
    expect(res.statusCode).toBe(401)
  })
})
