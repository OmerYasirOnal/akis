import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { registerOAuthRoutes } from '../../src/api/oauth.routes.js'
import { UserStore } from '../../src/auth/UserStore.js'
import { cookieConfigFromEnv } from '../../src/auth/cookie.js'
import { signState, type HttpFetch } from '../../src/auth/oauth.js'

const SECRET = 'oauth-test-secret'
const GH_ENV = { GITHUB_OAUTH_CLIENT_ID: 'cid', GITHUB_OAUTH_CLIENT_SECRET: 'csecret', PUBLIC_BASE_URL: 'http://localhost:5173' }
const GOOGLE_ENV = { GOOGLE_OAUTH_CLIENT_ID: 'gcid', GOOGLE_OAUTH_CLIENT_SECRET: 'gsecret', PUBLIC_BASE_URL: 'http://localhost:5173' }

/** A fake provider HTTP: token endpoint + GitHub profile/emails. */
const fakeHttp: HttpFetch = async (url) => {
  const j = (b: unknown) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) })
  if (url.includes('login/oauth/access_token')) return j({ access_token: 'tok' })
  if (url.endsWith('/user')) return j({ id: 7, login: 'ada', name: 'Ada', email: 'ada@gh.dev' })
  if (url.endsWith('/user/emails')) return j([{ email: 'ada@gh.dev', primary: true, verified: true }])
  throw new Error('unexpected ' + url)
}

/** A fake Google provider HTTP: token endpoint + /oauth2/v3/userinfo, parameterized by email_verified. */
const fakeGoogleHttp = (emailVerified: boolean | string): HttpFetch => async (url) => {
  const j = (b: unknown) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) })
  if (url.includes('oauth2.googleapis.com/token')) return j({ access_token: 'gtok' })
  if (url.includes('/oauth2/v3/userinfo')) return j({ sub: 'g-77', email: 'grace@goog.dev', name: 'Grace', email_verified: emailVerified })
  throw new Error('unexpected ' + url)
}

function app(env: Record<string, string | undefined>, http?: HttpFetch, users = new UserStore(), signupDisabled?: boolean) {
  const f = Fastify({ logger: false })
  registerOAuthRoutes(f, { users, secret: SECRET, cookie: cookieConfigFromEnv(env), env, ...(http ? { http } : {}), ...(signupDisabled !== undefined ? { signupDisabled } : {}) })
  return { f, users }
}

describe('oauth routes', () => {
  it('GET /oauth/providers lists configured providers', async () => {
    const { f } = app(GH_ENV)
    const res = await f.inject({ method: 'GET', url: '/oauth/providers' })
    expect(res.json().providers).toEqual(['github'])
  })

  it('authorize redirects to the provider when configured', async () => {
    const { f } = app(GH_ENV)
    const res = await f.inject({ method: 'GET', url: '/oauth/github/authorize' })
    expect(res.statusCode).toBe(302)
    const loc = res.headers.location as string
    expect(loc.startsWith('https://github.com/login/oauth/authorize')).toBe(true)
    expect(loc).toContain('client_id=cid')
    expect(loc).toContain('redirect_uri=http')
    expect(loc).toContain('state=')
  })

  it('authorize redirects to /login?error=oauth_unavailable when not configured', async () => {
    const { f } = app({ PUBLIC_BASE_URL: 'http://localhost:5173' })
    const res = await f.inject({ method: 'GET', url: '/oauth/github/authorize' })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('http://localhost:5173/login?error=oauth_unavailable')
  })

  it('callback exchanges code, creates the user, sets the session cookie, redirects home', async () => {
    const { f, users } = app(GH_ENV, fakeHttp)
    const state = signState('github', SECRET)
    const res = await f.inject({ method: 'GET', url: `/oauth/github/callback?code=abc&state=${state}` })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('http://localhost:5173/')
    expect(String(res.headers['set-cookie'])).toContain('HttpOnly')
    expect(await users.findByEmail('ada@gh.dev')).toBeTruthy()
  })

  it('callback with a bad state redirects to /login?error=oauth_state (no token exchange)', async () => {
    let called = false
    const { f } = app(GH_ENV, async (u) => { called = true; return { ok: true, status: 200, json: async () => ({}), text: async () => '' } })
    const res = await f.inject({ method: 'GET', url: '/oauth/github/callback?code=abc&state=forged' })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('http://localhost:5173/login?error=oauth_state')
    expect(called).toBe(false)
  })

  it('callback surfaces provider failure as a generic /login?error=oauth_failed', async () => {
    const failing: HttpFetch = async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => '' })
    const { f } = app(GH_ENV, failing)
    const res = await f.inject({ method: 'GET', url: `/oauth/github/callback?code=abc&state=${signState('github', SECRET)}` })
    expect(res.headers.location).toBe('http://localhost:5173/login?error=oauth_failed')
  })

  // SINGLE-USER GATE: OAuth must not create a new account when signup is disabled (else it bypasses
  // the no-open-signup / no-sandbox-RCE posture). Existing-account login/link must still work.
  it('signupDisabled: callback for an UNKNOWN verified email is DENIED and creates NO user', async () => {
    const { f, users } = app(GH_ENV, fakeHttp, new UserStore(), true)
    const res = await f.inject({ method: 'GET', url: `/oauth/github/callback?code=abc&state=${signState('github', SECRET)}` })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('http://localhost:5173/login?error=oauth_denied')
    expect(res.headers['set-cookie']).toBeUndefined() // no session minted
    expect(await users.findByEmail('ada@gh.dev')).toBeUndefined() // NO account created
  })

  it('signupDisabled: callback for an EXISTING account links + logs in (no new user)', async () => {
    const users = new UserStore()
    const owner = await users.create({ name: 'Ada', email: 'ada@gh.dev', passwordHash: 'h' }) // pre-seeded owner
    const { f } = app(GH_ENV, fakeHttp, users, true)
    const res = await f.inject({ method: 'GET', url: `/oauth/github/callback?code=abc&state=${signState('github', SECRET)}` })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('http://localhost:5173/') // logged in
    expect(String(res.headers['set-cookie'])).toContain('HttpOnly')
    expect((await users.findByEmail('ada@gh.dev'))?.id).toBe(owner.id) // linked the SAME account, no new row
    expect((await users.findByEmail('ada@gh.dev'))?.externalId).toBe('github:7')
  })

  it('AKIS_OWNER_EMAIL allowlist: a non-owner verified email is DENIED even with signup enabled', async () => {
    const { f, users } = app({ ...GH_ENV, AKIS_OWNER_EMAIL: 'owner@elsewhere.dev' }, fakeHttp)
    const res = await f.inject({ method: 'GET', url: `/oauth/github/callback?code=abc&state=${signState('github', SECRET)}` })
    expect(res.headers.location).toBe('http://localhost:5173/login?error=oauth_denied')
    expect(await users.findByEmail('ada@gh.dev')).toBeUndefined()
  })

  // FR-oauth-signin-17 — an UNKNOWN provider is rejected at BOTH the authorize and callback
  // edges with the same generic ?error=oauth_unknown (no provider-shaped behavior leaks for an
  // unsupported provider; isOAuthProvider is the only gate). A regression that 404'd, 500'd, or
  // tried to look up creds/exchange for `facebook` would fail these.
  it('GET /oauth/facebook/authorize → 302 /login?error=oauth_unknown', async () => {
    const { f } = app(GH_ENV)
    const res = await f.inject({ method: 'GET', url: '/oauth/facebook/authorize' })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('http://localhost:5173/login?error=oauth_unknown')
  })

  it('GET /oauth/facebook/callback → 302 /login?error=oauth_unknown (no exchange)', async () => {
    let called = false
    const { f } = app(GH_ENV, async (u) => { called = true; return { ok: true, status: 200, json: async () => ({}), text: async () => '' } })
    const res = await f.inject({ method: 'GET', url: `/oauth/facebook/callback?code=abc&state=${signState('github', SECRET)}` })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('http://localhost:5173/login?error=oauth_unknown')
    expect(called).toBe(false) // unknown provider short-circuits before any HTTP
  })

  // FR-oauth-signin-18 — provider-side denial (?error=access_denied, e.g. the user clicked
  // "Cancel" on GitHub's consent screen) must map to oauth_denied and MUST NOT perform a token
  // exchange. The error branch is checked BEFORE code/state, so no HTTP fires.
  it('callback with ?error=access_denied → oauth_denied and NO token exchange', async () => {
    let called = false
    const { f, users } = app(GH_ENV, async (u) => { called = true; return { ok: true, status: 200, json: async () => ({ access_token: 'x' }), text: async () => '' } })
    const res = await f.inject({ method: 'GET', url: `/oauth/github/callback?error=access_denied&state=${signState('github', SECRET)}` })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('http://localhost:5173/login?error=oauth_denied')
    expect(called).toBe(false) // the provider denied — never hit the token endpoint
    expect(res.headers['set-cookie']).toBeUndefined()
    expect(await users.findByEmail('ada@gh.dev')).toBeUndefined()
  })

  // UC-oauth-signin-2 — Google callback. A provider-VERIFIED email creates+links the account,
  // mints the session cookie, and redirects home. An UNVERIFIED (or string 'false') email is an
  // account-takeover vector and must fail closed to the generic oauth_failed with NO user created.
  it('Google callback: email_verified:true → creates user, sets cookie, redirects home', async () => {
    const { f, users } = app(GOOGLE_ENV, fakeGoogleHttp(true))
    const res = await f.inject({ method: 'GET', url: `/oauth/google/callback?code=abc&state=${signState('google', SECRET)}` })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('http://localhost:5173/')
    expect(String(res.headers['set-cookie'])).toContain('HttpOnly')
    const u = await users.findByEmail('grace@goog.dev')
    expect(u).toBeTruthy()
    expect(u?.externalId).toBe('google:g-77')
  })

  it('Google callback: email_verified:false → oauth_failed, NO cookie, NO user (takeover guard)', async () => {
    const { f, users } = app(GOOGLE_ENV, fakeGoogleHttp(false))
    const res = await f.inject({ method: 'GET', url: `/oauth/google/callback?code=abc&state=${signState('google', SECRET)}` })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('http://localhost:5173/login?error=oauth_failed')
    expect(res.headers['set-cookie']).toBeUndefined()
    expect(await users.findByEmail('grace@goog.dev')).toBeUndefined()
  })
})
