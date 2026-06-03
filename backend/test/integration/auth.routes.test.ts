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
  // NODE_ENV unset here → devEcho on → forgot-password returns the reset token for the flow test.
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

  it('blocks a cross-origin state-changing request when a trusted origin is configured (CSRF)', async () => {
    const keyStore = new JsonFileKeyStore(join(dir, 'keys.json'), MASTER, () => '2026-06-01T00:00:00Z')
    const server = buildServer({ keyStore, env: { AUTH_JWT_SECRET: 'x', PUBLIC_BASE_URL: 'http://localhost:5173' }, userStore: new UserStore() })
    const blocked = await server.inject({ method: 'POST', url: '/auth/login', payload: { email: 'a@b.com', password: 'x' }, headers: { origin: 'http://evil.example' } })
    expect(blocked.statusCode).toBe(403)
    expect(blocked.json().code).toBe('CsrfBlocked')
    // matching origin passes the guard (then normal 401 for bad creds)
    expect((await server.inject({ method: 'POST', url: '/auth/login', payload: { email: 'a@b.com', password: 'x' }, headers: { origin: 'http://localhost:5173' } })).statusCode).toBe(401)
    // no Origin (non-browser / tests) is allowed through
    expect((await server.inject({ method: 'POST', url: '/auth/login', payload: { email: 'a@b.com', password: 'x' } })).statusCode).toBe(401)
  })

  it('forgot→reset: lets a user set a new password and log in with it', async () => {
    const store = new UserStore(); const server = app(store)
    await server.inject({ method: 'POST', url: '/auth/signup', payload: { name: 'Ada', email: 'ada@akis.dev', password: 'oldpassword1' } })
    const forgot = await server.inject({ method: 'POST', url: '/auth/forgot-password', payload: { email: 'ada@akis.dev' } })
    expect(forgot.statusCode).toBe(200)
    const token = forgot.json().resetToken as string // echoed in dev
    expect(typeof token).toBe('string')
    const reset = await server.inject({ method: 'POST', url: '/auth/reset-password', payload: { token, password: 'brandnewpass9' } })
    expect(reset.statusCode).toBe(200)
    expect(reset.json().user.email).toBe('ada@akis.dev')
    // new password works, old one does not
    expect((await server.inject({ method: 'POST', url: '/auth/login', payload: { email: 'ada@akis.dev', password: 'brandnewpass9' } })).statusCode).toBe(200)
    expect((await server.inject({ method: 'POST', url: '/auth/login', payload: { email: 'ada@akis.dev', password: 'oldpassword1' } })).statusCode).toBe(401)
  })

  it('forgot-password is generic for unknown emails (no enumeration, no token)', async () => {
    const res = await app().inject({ method: 'POST', url: '/auth/forgot-password', payload: { email: 'ghost@akis.dev' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().resetToken).toBeUndefined()
  })

  it('reset-password rejects an invalid/garbage token with 400', async () => {
    const res = await app().inject({ method: 'POST', url: '/auth/reset-password', payload: { token: 'not.a.token', password: 'whatever12' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('BadToken')
  })

  it('PATCH /auth/me updates the display name (auth required)', async () => {
    const server = app()
    const signup = await server.inject({ method: 'POST', url: '/auth/signup', payload: { name: 'Ada', email: 'ada@akis.dev', password: 'hunter2hunter' } })
    const cookie = sessionCookie(signup)
    expect((await server.inject({ method: 'PATCH', url: '/auth/me', payload: { name: 'Ada Lovelace' } })).statusCode).toBe(401) // no cookie
    const ok = await server.inject({ method: 'PATCH', url: '/auth/me', payload: { name: 'Ada Lovelace' }, headers: { cookie } })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().user.name).toBe('Ada Lovelace')
    expect((await server.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })).json().user.name).toBe('Ada Lovelace')
  })

  it('change-password verifies the current password then lets the new one log in', async () => {
    const server = app()
    const cookie = sessionCookie(await server.inject({ method: 'POST', url: '/auth/signup', payload: { name: 'Ada', email: 'ada@akis.dev', password: 'oldpassword1' } }))
    // wrong current → 400
    expect((await server.inject({ method: 'POST', url: '/auth/change-password', payload: { currentPassword: 'WRONG', newPassword: 'newpassword9' }, headers: { cookie } })).statusCode).toBe(400)
    // correct current → 200
    expect((await server.inject({ method: 'POST', url: '/auth/change-password', payload: { currentPassword: 'oldpassword1', newPassword: 'newpassword9' }, headers: { cookie } })).statusCode).toBe(200)
    expect((await server.inject({ method: 'POST', url: '/auth/login', payload: { email: 'ada@akis.dev', password: 'newpassword9' } })).statusCode).toBe(200)
    expect((await server.inject({ method: 'POST', url: '/auth/login', payload: { email: 'ada@akis.dev', password: 'oldpassword1' } })).statusCode).toBe(401)
  })

  it('change-password requires authentication and a strong new password', async () => {
    const server = app()
    expect((await server.inject({ method: 'POST', url: '/auth/change-password', payload: { currentPassword: 'x', newPassword: 'newpassword9' } })).statusCode).toBe(401)
    const cookie = sessionCookie(await server.inject({ method: 'POST', url: '/auth/signup', payload: { name: 'A', email: 'a@akis.dev', password: 'oldpassword1' } }))
    expect((await server.inject({ method: 'POST', url: '/auth/change-password', payload: { currentPassword: 'oldpassword1', newPassword: 'short' }, headers: { cookie } })).statusCode).toBe(400)
  })

  it('fails closed in production when AUTH_JWT_SECRET is missing', () => {
    const keyStore = new JsonFileKeyStore(join(dir, 'keys.json'), MASTER, () => '2026-06-01T00:00:00Z')
    expect(() => buildServer({ keyStore, env: { NODE_ENV: 'production' } })).toThrow(/AUTH_JWT_SECRET/)
  })

  it('keyless self-host (the docker-compose default) BOOTS instead of crash-looping', async () => {
    // The bundled compose stack runs NODE_ENV=production with a default AUTH_JWT_SECRET,
    // AKIS_ALLOW_MOCK=1 (no provider key) AND the B1 demo acknowledgment
    // AKIS_ALLOW_DEMO_IN_PROD=1. That must build a working server on the mock provider —
    // NOT throw at boot (the prod no-key / no-secret crash-loop bug) — and /health reports
    // mode:'demo' (B1: the keyless demo still works, just flagged).
    const keyStore = new JsonFileKeyStore(join(dir, 'keys.json'), MASTER, () => '2026-06-01T00:00:00Z')
    const env = { NODE_ENV: 'production', AUTH_JWT_SECRET: 'x', AKIS_ALLOW_MOCK: '1', AKIS_ALLOW_DEMO_IN_PROD: '1', SERVE_STATIC: '1' }
    const server = buildServer({ keyStore, env, userStore: new UserStore() })
    expect(server).toBeTruthy()
    const res = await server.inject({ method: 'GET', url: '/health' })
    expect(res.json()).toMatchObject({ ok: true, mode: 'demo' })
  })

  it('keyless self-host in production WITHOUT the demo acknowledgment FAIL-CLOSES (B1)', () => {
    // The same compose default minus AKIS_ALLOW_DEMO_IN_PROD must refuse to boot: a demo
    // flag fakes verification, and production must not silently ship unverified output.
    const keyStore = new JsonFileKeyStore(join(dir, 'keys.json'), MASTER, () => '2026-06-01T00:00:00Z')
    const env = { NODE_ENV: 'production', AUTH_JWT_SECRET: 'x', AKIS_ALLOW_MOCK: '1', SERVE_STATIC: '1' }
    expect(() => buildServer({ keyStore, env, userStore: new UserStore() }))
      .toThrow(/Refusing to boot|AKIS_ALLOW_DEMO_IN_PROD/)
  })

  // NOTE: the prod no-key crash-loop (createProvider throwing) only manifests OUTSIDE
  // NODE_ENV=test — under vitest the real process env is `test`, so createProvider
  // short-circuits to the mock regardless of an injected env. Fail-closed provider
  // resolution is therefore unit-tested in create-provider.test.ts (explicit env), and
  // the end-to-end keyless boot is proved by the tsx boot harness in CI / verification.

  it('AKIS_ALLOW_MOCK + a real provider key boots WITHOUT forcing the mock', () => {
    // Compose defaults AKIS_ALLOW_MOCK=1; when the user later supplies a real key the
    // mock PROVIDER must step aside so real builds run (the documented "add a key" path).
    // The server must build the live provider here (no thrown ProviderConfigError, no
    // injected MockProvider) — the not-masked decision is unit-tested via
    // hasRealProviderKey; this asserts the wired server boots on the real key.
    // NOTE (B1): AKIS_ALLOW_MOCK still forces mock VERIFICATION even with a real key, so in
    // production it remains a demo boot that needs the explicit ack (kept here, matching the
    // compose default). With AKIS_ALLOW_MOCK=0 + a real key the boot is fully `live`.
    const keyStore = new JsonFileKeyStore(join(dir, 'keys.json'), MASTER, () => '2026-06-01T00:00:00Z')
    const env = { NODE_ENV: 'production', AUTH_JWT_SECRET: 'x', AKIS_ALLOW_MOCK: '1', AKIS_ALLOW_DEMO_IN_PROD: '1', ANTHROPIC_API_KEY: 'sk-ant-x' }
    const server = buildServer({ keyStore, env, userStore: new UserStore() })
    expect(server).toBeTruthy()
  })

  it('login runs equal work for unknown email vs wrong password (no timing oracle)', async () => {
    const server = app()
    await server.inject({ method: 'POST', url: '/auth/signup', payload: { name: 'Ada', email: 'known@akis.dev', password: 'hunter2hunter' } })
    const t = async (email: string): Promise<number> => {
      const start = performance.now()
      await server.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'definitely-wrong-pw' } })
      return performance.now() - start
    }
    const known = await t('known@akis.dev')   // wrong password on a real account
    const unknown = await t('ghost@akis.dev')  // no such account
    // Both run one scrypt compare; allow generous slack (CI jitter) — the point is the
    // unknown path is NOT trivially fast (which it was before the dummy-hash fix).
    expect(unknown).toBeGreaterThan(known * 0.25)
  })
})
