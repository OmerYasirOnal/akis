import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildServer } from '../../src/api/server.js'
import { JsonFileKeyStore } from '../../src/keys/KeyStore.js'
import { UserStore } from '../../src/auth/UserStore.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MASTER = '0'.repeat(64)
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'akis-authhard-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function app(userStore = new UserStore()) {
  const keyStore = new JsonFileKeyStore(join(dir, 'keys.json'), MASTER, () => '2026-06-01T00:00:00Z')
  return buildServer({ keyStore, env: { AUTH_JWT_SECRET: 'integration-secret' }, userStore })
}

function sessionCookie(res: { headers: Record<string, unknown> }): string {
  const sc = res.headers['set-cookie']
  const raw = Array.isArray(sc) ? sc[0] : (sc as string)
  return raw.split(';')[0]!
}

const SIGNUP = { name: 'Ada', email: 'ada@x.test', password: 'hunter22pass' }

describe('auth hardening — rate limiting (audit gap)', () => {
  it('login 429s after 10 attempts from one IP, with retry-after; the window is per-IP', async () => {
    const server = app()
    await server.inject({ method: 'POST', url: '/auth/signup', payload: SIGNUP })
    // 10 wrong-password attempts consume the window (401s)…
    for (let i = 0; i < 10; i++) {
      const r = await server.inject({ method: 'POST', url: '/auth/login', payload: { email: SIGNUP.email, password: 'WRONG' }, remoteAddress: '10.0.0.1' })
      expect(r.statusCode).toBe(401)
    }
    // …the 11th is rate-limited even with the CORRECT password (the limiter sits in front).
    const blocked = await server.inject({ method: 'POST', url: '/auth/login', payload: { email: SIGNUP.email, password: SIGNUP.password }, remoteAddress: '10.0.0.1' })
    expect(blocked.statusCode).toBe(429)
    expect(blocked.json()).toMatchObject({ code: 'RateLimited' })
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThanOrEqual(1)
    // A DIFFERENT IP is unaffected (per-IP key).
    const other = await server.inject({ method: 'POST', url: '/auth/login', payload: { email: SIGNUP.email, password: SIGNUP.password }, remoteAddress: '10.0.0.2' })
    expect(other.statusCode).toBe(200)
    await server.close()
  })

  it('signup 429s after 5 attempts from one IP', async () => {
    const server = app()
    for (let i = 0; i < 5; i++) {
      await server.inject({ method: 'POST', url: '/auth/signup', payload: { ...SIGNUP, email: `u${i}@x.test` }, remoteAddress: '10.9.9.9' })
    }
    const blocked = await server.inject({ method: 'POST', url: '/auth/signup', payload: { ...SIGNUP, email: 'u6@x.test' }, remoteAddress: '10.9.9.9' })
    expect(blocked.statusCode).toBe(429)
    await server.close()
  })
})

describe('auth hardening — token revocation (tokenVersion)', () => {
  it('logout-all kills every outstanding session: the old cookie stops verifying', async () => {
    const server = app()
    const signup = await server.inject({ method: 'POST', url: '/auth/signup', payload: SIGNUP })
    const cookieA = sessionCookie(signup)
    const login = await server.inject({ method: 'POST', url: '/auth/login', payload: { email: SIGNUP.email, password: SIGNUP.password } })
    const cookieB = sessionCookie(login)
    // Both sessions valid…
    expect((await server.inject({ method: 'GET', url: '/auth/me', headers: { cookie: cookieA } })).statusCode).toBe(200)
    expect((await server.inject({ method: 'GET', url: '/auth/me', headers: { cookie: cookieB } })).statusCode).toBe(200)
    // …logout-all from session B…
    const out = await server.inject({ method: 'POST', url: '/auth/logout-all', headers: { cookie: cookieB } })
    expect(out.statusCode).toBe(200)
    // …and BOTH old tokens are dead (tv mismatch), not just the one that called it.
    expect((await server.inject({ method: 'GET', url: '/auth/me', headers: { cookie: cookieA } })).statusCode).toBe(401)
    expect((await server.inject({ method: 'GET', url: '/auth/me', headers: { cookie: cookieB } })).statusCode).toBe(401)
    await server.close()
  })

  it('a password CHANGE revokes other sessions but keeps the changing client signed in', async () => {
    const server = app()
    const signup = await server.inject({ method: 'POST', url: '/auth/signup', payload: SIGNUP })
    const stolen = sessionCookie(signup) // an attacker holding an old cookie
    const login = await server.inject({ method: 'POST', url: '/auth/login', payload: { email: SIGNUP.email, password: SIGNUP.password } })
    const mine = sessionCookie(login)
    const change = await server.inject({
      method: 'POST', url: '/auth/change-password',
      headers: { cookie: mine },
      payload: { currentPassword: SIGNUP.password, newPassword: 'new-password-9' },
    })
    expect(change.statusCode).toBe(200)
    // The change RE-ISSUES this client's cookie with the new version…
    const freshMine = sessionCookie(change)
    expect((await server.inject({ method: 'GET', url: '/auth/me', headers: { cookie: freshMine } })).statusCode).toBe(200)
    // …while the stolen old cookie is dead.
    expect((await server.inject({ method: 'GET', url: '/auth/me', headers: { cookie: stolen } })).statusCode).toBe(401)
    await server.close()
  })

  it('a password RESET revokes outstanding sessions and signs in with the new version', async () => {
    const server = app()
    const signup = await server.inject({ method: 'POST', url: '/auth/signup', payload: SIGNUP })
    const oldCookie = sessionCookie(signup)
    const forgot = await server.inject({ method: 'POST', url: '/auth/forgot-password', payload: { email: SIGNUP.email } })
    const token = (forgot.json() as { resetToken?: string }).resetToken
    expect(token).toBeTruthy()
    const reset = await server.inject({ method: 'POST', url: '/auth/reset-password', payload: { token, password: 'fresh-password-1' } })
    expect(reset.statusCode).toBe(200)
    // The pre-reset session (e.g. on a stolen device) is dead; the fresh one works.
    expect((await server.inject({ method: 'GET', url: '/auth/me', headers: { cookie: oldCookie } })).statusCode).toBe(401)
    expect((await server.inject({ method: 'GET', url: '/auth/me', headers: { cookie: sessionCookie(reset) } })).statusCode).toBe(200)
    await server.close()
  })
})
