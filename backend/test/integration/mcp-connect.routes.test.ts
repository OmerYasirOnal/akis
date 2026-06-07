import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { registerMcpConnectRoutes, mcpTransportFor, type RemoteMcpAuthFn, type RemoteMcpProviderConfig } from '../../src/api/mcpConnect.routes.js'
import { MemoryRemoteMcpAuthStore, StoreBackedOAuthProvider } from '../../src/agent/mcp/StoreBackedOAuthProvider.js'
import { signConnectState, verifyConnectState } from '../../src/auth/oauth.js'
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'

const SECRET = 'test-state-secret'

const PROVIDERS: Record<string, RemoteMcpProviderConfig> = {
  atlassian: { serverUrl: 'https://mcp.example/v1', kind: 'streamable-http', scope: 'offline_access write:jira-work' },
}
const ENV = { PUBLIC_BASE_URL: 'https://akis.app' }
const tokens: OAuthTokens = { access_token: 'at', token_type: 'bearer', refresh_token: 'rt' }

/** A fake SDK auth(): on the connect step (no code) it "DCR-registers" + captures an authorize URL
 *  and returns REDIRECT; on the callback step (with code) it saves tokens and returns AUTHORIZED. */
const fakeAuth: RemoteMcpAuthFn = async (provider, opts) => {
  if (opts.authorizationCode) {
    ;(provider as StoreBackedOAuthProvider).saveTokens(tokens)
    return 'AUTHORIZED'
  }
  ;(provider as StoreBackedOAuthProvider).saveCodeVerifier('pkce')
  ;(provider as StoreBackedOAuthProvider).redirectToAuthorization(new URL('https://auth.example/authorize?client_id=dcr&code_challenge=x'))
  return 'REDIRECT'
}

function app(opts: { userId?: string; auth?: RemoteMcpAuthFn; store?: MemoryRemoteMcpAuthStore } = {}) {
  const store = opts.store ?? new MemoryRemoteMcpAuthStore()
  const f = Fastify({ logger: false })
  registerMcpConnectRoutes(f, {
    store, env: ENV, providers: PROVIDERS, secret: SECRET,
    auth: opts.auth ?? fakeAuth,
    userIdOf: async () => opts.userId,
  })
  return { f, store }
}

describe('mcp connect routes', () => {
  it('connect → 302 to the captured authorize URL with a SIGNED state (DCR + PKCE driven by the SDK)', async () => {
    const { f } = app({ userId: 'u1' })
    const res = await f.inject({ method: 'GET', url: '/mcp/atlassian/connect' })
    expect(res.statusCode).toBe(302)
    const loc = new URL(res.headers.location as string)
    expect(`${loc.origin}${loc.pathname}`).toBe('https://auth.example/authorize')
    expect(loc.searchParams.get('client_id')).toBe('dcr') // the SDK's captured params survive
    // a state WE signed, bound to this user + provider (CSRF / flow-integrity)
    expect(verifyConnectState(loc.searchParams.get('state') ?? '', SECRET)).toEqual({ userId: 'u1', repo: 'atlassian' })
  })

  it('connect requires auth (401) and rejects an unknown provider', async () => {
    expect((await app({}).f.inject({ method: 'GET', url: '/mcp/atlassian/connect' })).statusCode).toBe(401)
    const res = await app({ userId: 'u1' }).f.inject({ method: 'GET', url: '/mcp/nope/connect' })
    expect(res.headers.location).toBe('https://akis.app/settings?mcp=unknown')
  })

  it('callback with a VALID state exchanges the code → tokens stored, verifier cleared, connected', async () => {
    const { f, store } = app({ userId: 'u1' })
    const state = signConnectState('u1', 'atlassian', SECRET)
    const res = await f.inject({ method: 'GET', url: `/mcp/atlassian/callback?code=abc&state=${encodeURIComponent(state)}` })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('https://akis.app/settings?mcp=connected')
    expect(store.load('u1', 'atlassian')?.tokens).toEqual(tokens)
    expect(store.load('u1', 'atlassian')?.codeVerifier).toBeUndefined() // spent verifier cleared
  })

  it('callback REJECTS a missing / forged / cross-user state → denied, NO token exchange (CSRF)', async () => {
    const noCall: RemoteMcpAuthFn = async () => { throw new Error('token exchange must not run on a bad state') }
    // (a) missing state
    const a = app({ userId: 'u1', auth: noCall })
    expect((await a.f.inject({ method: 'GET', url: '/mcp/atlassian/callback?code=abc' })).headers.location).toBe('https://akis.app/settings?mcp=denied')
    expect(a.store.load('u1', 'atlassian')).toBeUndefined()
    // (b) forged/garbage state
    const b = app({ userId: 'u1', auth: noCall })
    expect((await b.f.inject({ method: 'GET', url: '/mcp/atlassian/callback?code=abc&state=not-a-real-state' })).headers.location).toBe('https://akis.app/settings?mcp=denied')
    // (c) a state validly signed for ANOTHER user — must not authorize u1's connection
    const c = app({ userId: 'u1', auth: noCall })
    const otherUser = signConnectState('attacker', 'atlassian', SECRET)
    expect((await c.f.inject({ method: 'GET', url: `/mcp/atlassian/callback?code=abc&state=${encodeURIComponent(otherUser)}` })).headers.location).toBe('https://akis.app/settings?mcp=denied')
    expect(c.store.load('u1', 'atlassian')).toBeUndefined()
    // (d) a state signed for a DIFFERENT provider — must not cross providers
    const d = app({ userId: 'u1', auth: noCall })
    const otherProv = signConnectState('u1', 'github', SECRET)
    expect((await d.f.inject({ method: 'GET', url: `/mcp/atlassian/callback?code=abc&state=${encodeURIComponent(otherProv)}` })).headers.location).toBe('https://akis.app/settings?mcp=denied')
  })

  it('callback with a provider error or no code → denied (no token exchange)', async () => {
    const { f, store } = app({ userId: 'u1', auth: async () => { throw new Error('should not be called') } })
    const res = await f.inject({ method: 'GET', url: '/mcp/atlassian/callback?error=access_denied' })
    expect(res.headers.location).toBe('https://akis.app/settings?mcp=denied')
    expect(store.load('u1', 'atlassian')).toBeUndefined()
  })

  it('status reports connected only when tokens exist; disconnect wipes it', async () => {
    const { f, store } = app({ userId: 'u1' })
    expect((await f.inject({ method: 'GET', url: '/mcp/atlassian/status' })).json()).toEqual({ connected: false })
    store.save('u1', 'atlassian', { tokens })
    expect((await f.inject({ method: 'GET', url: '/mcp/atlassian/status' })).json().connected).toBe(true)
    await f.inject({ method: 'DELETE', url: '/mcp/atlassian' })
    expect(store.load('u1', 'atlassian')).toBeUndefined()
  })

  it('callback under SameSite=Strict (NO session cookie) still connects via the signed state (#2)', async () => {
    // Under AUTH_COOKIE_SAMESITE=strict the cookie is DROPPED on the cross-site OAuth return → userIdOf
    // is undefined. The signed state is the unforgeable identity binding, so connect must still succeed
    // and store the tokens under the STATE's userId (mirrors /auth/github/callback).
    const { f, store } = app({}) // no userId ⇒ no session cookie (Strict)
    const state = signConnectState('u1', 'atlassian', SECRET)
    const res = await f.inject({ method: 'GET', url: `/mcp/atlassian/callback?code=abc&state=${encodeURIComponent(state)}` })
    expect(res.headers.location).toBe('https://akis.app/settings?mcp=connected')
    expect(store.load('u1', 'atlassian')?.tokens).toEqual(tokens)
  })

  it('callback DENIES when a PRESENT cookie mismatches the signed-state userId (defense-in-depth)', async () => {
    const noCall: RemoteMcpAuthFn = async () => { throw new Error('must not exchange on a cookie/state mismatch') }
    const { f, store } = app({ userId: 'mallory', auth: noCall }) // cookie says mallory…
    const state = signConnectState('u1', 'atlassian', SECRET) // …state says u1
    const res = await f.inject({ method: 'GET', url: `/mcp/atlassian/callback?code=abc&state=${encodeURIComponent(state)}` })
    expect(res.headers.location).toBe('https://akis.app/settings?mcp=denied')
    expect(store.load('u1', 'atlassian')).toBeUndefined()
    expect(store.load('mallory', 'atlassian')).toBeUndefined()
  })

  it('DELETE on an UNKNOWN provider → 404 (parity with /status), never a silent ok (#1)', async () => {
    const { f } = app({ userId: 'u1' })
    const res = await f.inject({ method: 'DELETE', url: '/mcp/garbage' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: 'UnknownProvider' })
  })

  it('disconnect is IDEMPOTENT — a second DELETE still 200 {ok:true}, store stays empty (#3)', async () => {
    const { f, store } = app({ userId: 'u1' })
    store.save('u1', 'atlassian', { tokens })
    const r1 = await f.inject({ method: 'DELETE', url: '/mcp/atlassian' })
    expect(r1.statusCode).toBe(200); expect(r1.json()).toEqual({ ok: true })
    expect(store.load('u1', 'atlassian')).toBeUndefined()
    const r2 = await f.inject({ method: 'DELETE', url: '/mcp/atlassian' }) // already gone
    expect(r2.statusCode).toBe(200); expect(r2.json()).toEqual({ ok: true })
    expect(store.load('u1', 'atlassian')).toBeUndefined()
  })
})

describe('mcpTransportFor', () => {
  it('returns a transport for a CONNECTED provider, undefined otherwise (honest absence)', () => {
    const store = new MemoryRemoteMcpAuthStore()
    expect(mcpTransportFor({ userId: 'u1', provider: 'atlassian', store, env: ENV, providers: PROVIDERS })).toBeUndefined()
    expect(mcpTransportFor({ userId: 'u1', provider: 'nope', store, env: ENV, providers: PROVIDERS })).toBeUndefined()
    store.save('u1', 'atlassian', { tokens })
    expect(mcpTransportFor({ userId: 'u1', provider: 'atlassian', store, env: ENV, providers: PROVIDERS })).toBeDefined()
  })
})
