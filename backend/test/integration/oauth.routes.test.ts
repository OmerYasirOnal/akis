import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { registerOAuthRoutes } from '../../src/api/oauth.routes.js'
import { UserStore } from '../../src/auth/UserStore.js'
import { cookieConfigFromEnv } from '../../src/auth/cookie.js'
import { signState, type HttpFetch } from '../../src/auth/oauth.js'

const SECRET = 'oauth-test-secret'
const GH_ENV = { GITHUB_OAUTH_CLIENT_ID: 'cid', GITHUB_OAUTH_CLIENT_SECRET: 'csecret', PUBLIC_BASE_URL: 'http://localhost:5173' }

/** A fake provider HTTP: token endpoint + GitHub profile/emails. */
const fakeHttp: HttpFetch = async (url) => {
  const j = (b: unknown) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) })
  if (url.includes('login/oauth/access_token')) return j({ access_token: 'tok' })
  if (url.endsWith('/user')) return j({ id: 7, login: 'ada', name: 'Ada', email: 'ada@gh.dev' })
  if (url.endsWith('/user/emails')) return j([{ email: 'ada@gh.dev', primary: true, verified: true }])
  throw new Error('unexpected ' + url)
}

function app(env: Record<string, string | undefined>, http?: HttpFetch, users = new UserStore()) {
  const f = Fastify({ logger: false })
  registerOAuthRoutes(f, { users, secret: SECRET, cookie: cookieConfigFromEnv(env), env, ...(http ? { http } : {}) })
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
})
