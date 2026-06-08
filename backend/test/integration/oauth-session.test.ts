import { describe, it, expect, vi, afterEach } from 'vitest'
import Fastify from 'fastify'
import { registerOAuthRoutes } from '../../src/api/oauth.routes.js'
import { registerAuthRoutes } from '../../src/api/auth.routes.js'
import { UserStore } from '../../src/auth/UserStore.js'
import { cookieConfigFromEnv } from '../../src/auth/cookie.js'
import { signState, exchangeCode, fetchProfile, type HttpFetch } from '../../src/auth/oauth.js'

const SECRET = 'oauth-session-secret'
const GH_ENV = { GITHUB_OAUTH_CLIENT_ID: 'cid', GITHUB_OAUTH_CLIENT_SECRET: 'csecret', PUBLIC_BASE_URL: 'http://localhost:5173' }

/** Fake GitHub provider HTTP — token + profile. The token string is FIXED so NFR-6 can assert
 *  it is never logged. */
const ACCESS_TOKEN = 'gho_SECRET_ACCESS_TOKEN_should_never_be_logged'
const fakeHttp: HttpFetch = async (url) => {
  const j = (b: unknown) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) })
  if (url.includes('login/oauth/access_token')) return j({ access_token: ACCESS_TOKEN })
  if (url.endsWith('/user')) return j({ id: 7, login: 'ada', name: 'Ada', email: 'ada@gh.dev' })
  if (url.endsWith('/user/emails')) return j([{ email: 'ada@gh.dev', primary: true, verified: true }])
  throw new Error('unexpected ' + url)
}

/** One Fastify with BOTH the oauth callback (to mint a real session cookie) and /auth/me (to
 *  verify it), sharing the SAME UserStore + secret + cookie config — so a tokenVersion bump in the
 *  store is observed by the cookie verifier exactly as in production. */
function app() {
  const users = new UserStore()
  const f = Fastify({ logger: false })
  const cookie = cookieConfigFromEnv(GH_ENV)
  registerOAuthRoutes(f, { users, secret: SECRET, cookie, env: GH_ENV, http: fakeHttp })
  registerAuthRoutes(f, { users, secret: SECRET, cookie })
  return { f, users }
}

function sessionCookie(res: { headers: Record<string, unknown> }): string {
  const sc = res.headers['set-cookie']
  const raw = Array.isArray(sc) ? sc[0] : (sc as string)
  return raw.split(';')[0]!
}

describe('NFR-oauth-signin-5 — OAuth sessions revoke via tokenVersion', () => {
  it('a tokenVersion bump kills a previously-issued OAuth session cookie (/auth/me → 401)', async () => {
    const { f, users } = app()
    // OAuth-login: the callback mints a session cookie embedding the user's current tokenVersion.
    const login = await f.inject({ method: 'GET', url: `/oauth/github/callback?code=abc&state=${signState('github', SECRET)}` })
    expect(login.statusCode).toBe(302)
    const cookie = sessionCookie(login)
    // The freshly-minted cookie authenticates.
    expect((await f.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })).statusCode).toBe(200)
    // Revoke: bump the tokenVersion out-of-band (mirrors logout-all / password change).
    const user = await users.findByEmail('ada@gh.dev')
    expect(user).toBeTruthy()
    await users.bumpTokenVersion(user!.id)
    // The SAME cookie no longer verifies — the OAuth session is revoked just like a password one.
    expect((await f.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })).statusCode).toBe(401)
  })
})

describe('NFR-oauth-signin-6 — the access token is never logged', () => {
  afterEach(() => vi.restoreAllMocks())

  it('exchangeCode + fetchProfile never pass the access-token string to console.log/error/warn/info/debug', async () => {
    const spies = (['log', 'error', 'warn', 'info', 'debug'] as const).map(m => vi.spyOn(console, m).mockImplementation(() => {}))
    const creds = { code: 'c', clientId: 'i', clientSecret: 's', redirectUri: 'r' }
    const { token } = await exchangeCode('github', creds, fakeHttp)
    expect(token).toBe(ACCESS_TOKEN) // sanity: we are actually exercising the secret-bearing path
    const profile = await fetchProfile('github', token, fakeHttp)
    expect(profile.email).toBe('ada@gh.dev')
    // Scan EVERY argument of EVERY console call — the token must appear nowhere.
    const logged = spies.flatMap(s => s.mock.calls.flat()).map(a => {
      try { return typeof a === 'string' ? a : JSON.stringify(a) } catch { return String(a) }
    })
    for (const line of logged) expect(line).not.toContain(ACCESS_TOKEN)
  })
})
