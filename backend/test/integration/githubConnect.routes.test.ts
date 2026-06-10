import { describe, it, expect, vi, afterEach } from 'vitest'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { registerGitHubConnectRoutes } from '../../src/api/githubConnect.routes.js'
import { GitHubConnectionMemoryStore, type GitHubConnectionStore } from '../../src/keys/GitHubConnectionStore.js'
import { cookieConfigFromEnv } from '../../src/auth/cookie.js'
import { signConnectState, type HttpFetch } from '../../src/auth/oauth.js'

const SECRET = 'gh-connect-secret'
const BASE = 'http://localhost:5173'
const GH_ENV = { GITHUB_OAUTH_CLIENT_ID: 'cid', GITHUB_OAUTH_CLIENT_SECRET: 'csecret', PUBLIC_BASE_URL: BASE }
const ACCESS_TOKEN = 'ghp_callback_minted_secret_token_9999'

/** A fake GitHub HTTP: token endpoint (returns the access token + granted scope) + /user. */
const fakeHttp: HttpFetch = async (url) => {
  const j = (b: unknown) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) })
  if (url.includes('login/oauth/access_token')) return j({ access_token: ACCESS_TOKEN, scope: 'repo' })
  if (url.endsWith('/user')) return j({ id: 7, login: 'ada' })
  throw new Error('unexpected ' + url)
}

interface AppOpts {
  env?: Record<string, string | undefined>
  http?: HttpFetch
  connections?: GitHubConnectionStore
  /** The user id the request resolves to (undefined ⇒ anonymous / cookie dropped). */
  userId?: string | undefined
}
function app(opts: AppOpts = {}): { f: FastifyInstance; connections: GitHubConnectionStore } {
  const env = opts.env ?? GH_ENV
  const connections = opts.connections ?? new GitHubConnectionMemoryStore()
  const f = Fastify({ logger: false })
  const userIdOf = async (_req: FastifyRequest): Promise<string | undefined> => opts.userId
  registerGitHubConnectRoutes(f, { connections, secret: SECRET, cookie: cookieConfigFromEnv(env), env, userIdOf, ...(opts.http ? { http: opts.http } : {}) })
  return { f, connections }
}

afterEach(() => vi.restoreAllMocks())

describe('GET /auth/github/connect (A2.1 token-only — no repo required)', () => {
  it('401 when unauthenticated', async () => {
    const { f } = app({ userId: undefined })
    const res = await f.inject({ method: 'GET', url: '/auth/github/connect' })
    expect(res.statusCode).toBe(401)
  })

  it('302s to github.com WITHOUT a repo query (A2.1: connect only authenticates)', async () => {
    const { f } = app({ userId: 'u1' })
    const res = await f.inject({ method: 'GET', url: '/auth/github/connect' })
    expect(res.statusCode).toBe(302)
    const loc = res.headers.location as string
    expect(loc.startsWith('https://github.com/login/oauth/authorize')).toBe(true)
    expect(loc).toContain('scope=repo')
    expect(loc).toContain('state=')
  })

  it('IGNORES a stray ?repo= and still 302s (token-only connect; per-project repos)', async () => {
    const { f } = app({ userId: 'u1' })
    const res = await f.inject({ method: 'GET', url: '/auth/github/connect?repo=anything-here' })
    expect(res.statusCode).toBe(302)
    expect((res.headers.location as string).startsWith('https://github.com/login/oauth/authorize')).toBe(true)
  })

  it('redirects ?github=unavailable when the OAuth app is not configured', async () => {
    const { f } = app({ userId: 'u1', env: { PUBLIC_BASE_URL: BASE } })
    const res = await f.inject({ method: 'GET', url: '/auth/github/connect' })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe(`${BASE}/settings?github=unavailable`)
  })

  it('redirects ?github=unavailable when encryption cannot store (canStore=false)', async () => {
    const connections: GitHubConnectionStore = { ...new GitHubConnectionMemoryStore(), canStore: () => false } as GitHubConnectionStore
    const { f } = app({ userId: 'u1', connections })
    const res = await f.inject({ method: 'GET', url: '/auth/github/connect' })
    expect(res.headers.location).toBe(`${BASE}/settings?github=unavailable`)
  })

  it('302s to github.com with scope=repo when authorized + configured (no token in URL)', async () => {
    const { f } = app({ userId: 'u1' })
    const res = await f.inject({ method: 'GET', url: '/auth/github/connect' })
    expect(res.statusCode).toBe(302)
    const loc = res.headers.location as string
    expect(loc.startsWith('https://github.com/login/oauth/authorize')).toBe(true)
    expect(loc).toContain('scope=repo')
    expect(loc).toContain('state=')
    expect(loc).not.toContain(ACCESS_TOKEN)
  })
})

describe('GET /auth/github/callback', () => {
  it('?github=denied when GitHub returns error', async () => {
    let called = false
    const { f } = app({ userId: 'u1', http: async () => { called = true; return { ok: true, status: 200, json: async () => ({}), text: async () => '' } } })
    const res = await f.inject({ method: 'GET', url: '/auth/github/callback?error=access_denied&state=x' })
    expect(res.headers.location).toBe(`${BASE}/settings?github=denied`)
    expect(called).toBe(false)
  })

  it('?github=error on a forged/expired state — NO token exchange', async () => {
    let called = false
    const { f } = app({ userId: 'u1', http: async () => { called = true; return { ok: true, status: 200, json: async () => ({}), text: async () => '' } } })
    const res = await f.inject({ method: 'GET', url: '/auth/github/callback?code=abc&state=forged' })
    expect(res.headers.location).toBe(`${BASE}/settings?github=error`)
    expect(called).toBe(false)
  })

  it('?github=error on a cookie/state user MISMATCH (defense-in-depth) — NO token exchange', async () => {
    let called = false
    // Cookie resolves to a DIFFERENT user than the signed state.
    const { f } = app({ userId: 'attacker', http: async () => { called = true; return { ok: true, status: 200, json: async () => ({}), text: async () => '' } } })
    const state = signConnectState('victim', 'victim/app', SECRET)
    const res = await f.inject({ method: 'GET', url: `/auth/github/callback?code=abc&state=${state}` })
    expect(res.headers.location).toBe(`${BASE}/settings?github=error`)
    expect(called).toBe(false)
  })

  it('happy path stores an ENCRYPTED token + LOGIN (no repo, A2.1) and redirects ?github=connected — no Set-Cookie', async () => {
    const { f, connections } = app({ userId: 'u1', http: fakeHttp })
    const state = signConnectState('u1', 'connect', SECRET)
    const res = await f.inject({ method: 'GET', url: `/auth/github/callback?code=abc&state=${state}` })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe(`${BASE}/settings?github=connected`)
    // The connect callback NEVER mints a session.
    expect(res.headers['set-cookie']).toBeUndefined()
    // The connection was stored against the SIGNED-STATE user — token + login, NO repo (token-only).
    expect(connections.getToken('u1')).toBe(ACCESS_TOKEN)
    const st = connections.status('u1')
    expect(st).toMatchObject({ username: 'ada', scopes: ['repo'] })
    expect(st?.repo).toBeUndefined() // A2.1: per-project repos — connect stores no repo
    // No token in any response body/header.
    expect(JSON.stringify(res.headers)).not.toContain(ACCESS_TOKEN)
  })

  it('works under SameSite=Strict (cookie dropped → cookieUser undefined → cross-check skipped)', async () => {
    const env = { ...GH_ENV, AUTH_COOKIE_SAMESITE: 'strict' }
    // userId undefined simulates the dropped cookie on the cross-site callback.
    const { f, connections } = app({ userId: undefined, env, http: fakeHttp })
    const state = signConnectState('u1', 'connect', SECRET)
    const res = await f.inject({ method: 'GET', url: `/auth/github/callback?code=abc&state=${state}` })
    expect(res.headers.location).toBe(`${BASE}/settings?github=connected`)
    expect(connections.getToken('u1')).toBe(ACCESS_TOKEN)
  })
})

describe('GET /auth/github/status and DELETE /auth/github', () => {
  it('status 401 unauthenticated', async () => {
    const { f } = app({ userId: undefined })
    expect((await f.inject({ method: 'GET', url: '/auth/github/status' })).statusCode).toBe(401)
  })

  it('status reflects connected + configured and never returns the token', async () => {
    const connections = new GitHubConnectionMemoryStore()
    connections.set('u1', { accessToken: ACCESS_TOKEN, username: 'ada', scopes: ['repo'], repo: 'ada/app' })
    const { f } = app({ userId: 'u1', connections })
    const res = await f.inject({ method: 'GET', url: '/auth/github/status' })
    const body = res.json()
    expect(body).toMatchObject({ connected: true, configured: true, username: 'ada', repo: 'ada/app', scopes: ['repo'] })
    expect(JSON.stringify(body)).not.toContain(ACCESS_TOKEN)
  })

  it('status configured=false when the OAuth app is not configured', async () => {
    const { f } = app({ userId: 'u1', env: { PUBLIC_BASE_URL: BASE } })
    expect(((await f.inject({ method: 'GET', url: '/auth/github/status' })).json() as { configured: boolean }).configured).toBe(false)
  })

  it('disconnect removes the connection', async () => {
    const connections = new GitHubConnectionMemoryStore()
    connections.set('u1', { accessToken: ACCESS_TOKEN, username: 'ada', scopes: ['repo'], repo: 'ada/app' })
    const { f } = app({ userId: 'u1', connections })
    const res = await f.inject({ method: 'DELETE', url: '/auth/github' })
    expect(res.json()).toEqual({ removed: true })
    expect(connections.status('u1')).toBeUndefined()
  })
})

describe('no token EVER appears in logs (happy, error, exchange-failure)', () => {
  it('the access token never reaches console across all callback paths', async () => {
    const logs: string[] = []
    const cap = (...a: unknown[]): void => { logs.push(a.map(String).join(' ')) }
    vi.spyOn(console, 'log').mockImplementation(cap)
    vi.spyOn(console, 'error').mockImplementation(cap)
    vi.spyOn(console, 'warn').mockImplementation(cap)
    vi.spyOn(console, 'info').mockImplementation(cap)
    vi.spyOn(console, 'debug').mockImplementation(cap)

    // Happy path.
    {
      const { f } = app({ userId: 'u1', http: fakeHttp })
      await f.inject({ method: 'GET', url: `/auth/github/callback?code=abc&state=${signConnectState('u1', 'connect', SECRET)}` })
    }
    // Forged-state error path.
    {
      const { f } = app({ userId: 'u1', http: fakeHttp })
      await f.inject({ method: 'GET', url: '/auth/github/callback?code=abc&state=forged' })
    }
    // Token-exchange-failure path (returns a token but a later HTTP throws nothing logs it).
    {
      const failing: HttpFetch = async (url) => {
        if (url.includes('login/oauth/access_token')) return { ok: false, status: 500, json: async () => ({ access_token: ACCESS_TOKEN }), text: async () => ACCESS_TOKEN }
        throw new Error('boom')
      }
      const { f } = app({ userId: 'u1', http: failing })
      await f.inject({ method: 'GET', url: `/auth/github/callback?code=abc&state=${signConnectState('u1', 'connect', SECRET)}` })
    }

    expect(logs.join('\n')).not.toContain(ACCESS_TOKEN)
  })
})
