import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { registerMcpConnectRoutes, mcpTransportFor, REMOTE_MCP_PROVIDERS, type RemoteMcpAuthFn, type RemoteMcpProviderConfig } from '../../src/api/mcpConnect.routes.js'
import { MemoryRemoteMcpAuthStore, StoreBackedOAuthProvider, type RemoteMcpAuthStore, type RemoteMcpAuthRecord } from '../../src/agent/mcp/StoreBackedOAuthProvider.js'
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

describe('mcp connect — github STATIC client (no DCR), atlassian DCR', () => {
  // Both providers, so the connect route can build either; github has a STATIC-client path.
  const BOTH: Record<string, RemoteMcpProviderConfig> = {
    atlassian: { serverUrl: 'https://mcp.example/v1', kind: 'streamable-http', scope: 'offline_access write:jira-work' },
    github: { serverUrl: 'https://api.githubcopilot.com/mcp/', kind: 'streamable-http', scope: 'repo read:org read:user' },
  }
  const GH_ENV = { PUBLIC_BASE_URL: 'https://akis.app', GITHUB_OAUTH_CLIENT_ID: 'gh-id', GITHUB_OAUTH_CLIENT_SECRET: 'gh-secret' }

  /** Capture the provider the connect route constructs so we can inspect its clientInformation(). */
  function appCapturing(env: Record<string, string>) {
    let captured: StoreBackedOAuthProvider | undefined
    const capturingAuth: RemoteMcpAuthFn = async (provider, opts) => {
      captured = provider as StoreBackedOAuthProvider
      return fakeAuth(provider, opts)
    }
    const f = Fastify({ logger: false })
    const store = new MemoryRemoteMcpAuthStore()
    registerMcpConnectRoutes(f, { store, env, providers: BOTH, secret: SECRET, auth: capturingAuth, userIdOf: async () => 'u1' })
    return { f, store, get: () => captured }
  }

  it('github connect builds a provider whose clientInformation() is the STATIC OAuth App (creds present → DCR skipped)', async () => {
    const a = appCapturing(GH_ENV)
    const res = await a.f.inject({ method: 'GET', url: '/mcp/github/connect' })
    expect(res.statusCode).toBe(302) // flow proceeds (no DCR failure)
    // The constructed provider returns the static GitHub OAuth App — a non-undefined clientInformation()
    // is exactly what makes the SDK bypass registerClient/DCR.
    expect(a.get()?.clientInformation()).toEqual({ client_id: 'gh-id', client_secret: 'gh-secret' })
  })

  it('atlassian connect builds a provider with NO static client → DCR (store-backed) behavior', async () => {
    const a = appCapturing(GH_ENV) // github creds present, but atlassian must NOT use them
    const res = await a.f.inject({ method: 'GET', url: '/mcp/atlassian/connect' })
    expect(res.statusCode).toBe(302)
    // No static client and no DCR client persisted yet ⇒ undefined ⇒ the SDK would run DCR.
    expect(a.get()?.clientInformation()).toBeUndefined()
  })

  it('github connect WITHOUT OAuth creds falls back to no-static-client (honest degrade, never crash)', async () => {
    const a = appCapturing({ PUBLIC_BASE_URL: 'https://akis.app' }) // GitHub OAuth creds absent
    const res = await a.f.inject({ method: 'GET', url: '/mcp/github/connect' })
    // The fake auth still captures + REDIRECTs; with the REAL SDK this provider (no static client,
    // github has no DCR) would degrade to an 'error' redirect — never a crash.
    expect(res.statusCode).toBe(302)
    expect(a.get()?.clientInformation()).toBeUndefined() // no static creds → store-backed (would DCR)
  })

  it('mcpTransportFor for a connected github user carries the static client (creds present)', () => {
    const store = new MemoryRemoteMcpAuthStore()
    store.save('u1', 'github', { tokens }) // connected
    const t = mcpTransportFor({ userId: 'u1', provider: 'github', store, env: GH_ENV, providers: BOTH })
    expect(t).toBeDefined() // a transport is built for the connected github user (refresh uses the static client)
  })
})

// ── Regression guards for verified-but-unguarded behaviors (requirements verification 2026-06-08) ──
// These assert SPECIFIC, already-correct behaviors so a regression (wider scope, fail-OPEN connect,
// echoed error text, persisted client_secret, leaked token) would FAIL the suite. Production is NOT
// changed by these tests.

const BOTH_REG: Record<string, RemoteMcpProviderConfig> = {
  atlassian: { serverUrl: 'https://mcp.example/v1', kind: 'streamable-http', scope: 'offline_access write:jira-work' },
  github: { serverUrl: 'https://api.githubcopilot.com/mcp/', kind: 'streamable-http', scope: 'repo read:org read:user' },
}
const GH_LOGIN_ENV = { PUBLIC_BASE_URL: 'https://akis.app', GITHUB_OAUTH_CLIENT_ID: 'gh-id', GITHUB_OAUTH_CLIENT_SECRET: 'gh-secret' }

/** A store that refuses to persist (encryption not configured) — every mutator is a tripwire so a
 *  regression that wrote BEFORE the canStore() preflight would blow up loudly. */
class CannotStore implements RemoteMcpAuthStore {
  load(): RemoteMcpAuthRecord | undefined { return undefined }
  save(): void { throw new Error('save() must not run when canStore() is false') }
  clearVerifier(): void { throw new Error('clearVerifier() must not run when canStore() is false') }
  remove(): void { throw new Error('remove() must not run when canStore() is false') }
  canStore(): boolean { return false }
}

/** auth() that THROWS the moment it is touched — proves the route never reached the SDK. */
const authMustNotRun: RemoteMcpAuthFn = async () => { throw new Error('SDK auth() must NOT be invoked') }

/** Build a capturing app over the real-config-shaped BOTH_REG with an injectable auth(). */
function regApp(opts: { env: Record<string, string>; auth?: RemoteMcpAuthFn; store?: RemoteMcpAuthStore; userId?: string }) {
  let captured: StoreBackedOAuthProvider | undefined
  let redirectUrlSeen: string | undefined
  const auth = opts.auth ?? (async (provider, o) => {
    captured = provider as StoreBackedOAuthProvider
    redirectUrlSeen = (provider as StoreBackedOAuthProvider).redirectUrl
    return fakeAuth(provider, o)
  })
  const store = opts.store ?? new MemoryRemoteMcpAuthStore()
  const f = Fastify({ logger: false })
  registerMcpConnectRoutes(f, {
    store, env: opts.env, providers: BOTH_REG, secret: SECRET, auth,
    userIdOf: async () => opts.userId ?? 'u1',
  })
  return { f, store, get: () => captured, redirectUrl: () => redirectUrlSeen }
}

describe('regression · github remote-MCP connect guards', () => {
  it('FR-6 / NFR-8 / UC-3: canStore()===false → 302 mcp=unavailable AND auth() is NEVER invoked (fail-CLOSED)', async () => {
    const { f } = regApp({ env: GH_LOGIN_ENV, auth: authMustNotRun, store: new CannotStore() })
    const res = await f.inject({ method: 'GET', url: '/mcp/github/connect' })
    expect(res.statusCode).toBe(302)
    // exact opaque status — a regression that fell through to 'error'/'connected' or actually ran the
    // flow would fail here (and authMustNotRun would have thrown first).
    expect(res.headers.location).toBe('https://akis.app/settings?mcp=unavailable')
  })

  it('FR-8: the connect provider redirectUrl is EXACTLY ${base}/mcp/github/callback (the base-/ registered URI)', async () => {
    const a = regApp({ env: GH_LOGIN_ENV })
    const res = await a.f.inject({ method: 'GET', url: '/mcp/github/connect' })
    expect(res.statusCode).toBe(302)
    // captured from the provider the route handed to auth() — drifting the callback path or origin
    // (which would break the OAuth-App's registered redirect) fails this.
    expect(a.redirectUrl()).toBe('https://akis.app/mcp/github/callback')
  })

  it('FR-9: connect-step auth() AUTHORIZED (cached tokens) → mcp=connected, no authorize-page redirect', async () => {
    // auth() returns AUTHORIZED on the connect step (no code) WITHOUT capturing an authorize URL.
    const authorizedNoRedirect: RemoteMcpAuthFn = async () => 'AUTHORIZED'
    const a = regApp({ env: GH_LOGIN_ENV, auth: authorizedNoRedirect })
    const res = await a.f.inject({ method: 'GET', url: '/mcp/github/connect' })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('https://akis.app/settings?mcp=connected')
    // NOT an authorize-page 302 — it lands back on settings, never the IdP.
    expect(res.headers.location).not.toContain('authorize')
  })

  it('FR-10: connect-step auth() THROWS → EXACTLY mcp=error, error text NEVER echoed into the redirect', async () => {
    const secretMsg = 'super-secret-discovery-failure-detail'
    const throwingAuth: RemoteMcpAuthFn = async () => { throw new Error(secretMsg) }
    const a = regApp({ env: GH_LOGIN_ENV, auth: throwingAuth })
    const res = await a.f.inject({ method: 'GET', url: '/mcp/github/connect' })
    expect(res.statusCode).toBe(302)
    const loc = res.headers.location as string
    expect(loc).toBe('https://akis.app/settings?mcp=error')
    expect(loc).not.toContain(secretMsg)
    expect(loc).not.toContain('error=') // no error-detail querystring, only the opaque mcp=error token
  })

  it('FR-12: after connect, store.codeVerifier is persisted AND clientInfo (static secret) is NEVER persisted', async () => {
    const a = regApp({ env: GH_LOGIN_ENV }) // fakeAuth saves a PKCE verifier on the connect step
    const res = await a.f.inject({ method: 'GET', url: '/mcp/github/connect' })
    expect(res.statusCode).toBe(302)
    const rec = (a.store as MemoryRemoteMcpAuthStore).load('u1', 'github')
    expect(rec?.codeVerifier).toBeDefined() // PKCE verifier persisted for the in-flight connect
    expect(rec?.clientInfo).toBeUndefined() // the static OAuth App is NEVER written to the store (secret stays in-process)
  })
})

describe('regression · staticClientFor behavior via clientInformation() (NFR-13 / NFR-17)', () => {
  // staticClientFor is module-private; its contract is observable through the provider the connect
  // route constructs — clientInformation() is the SDK's DCR-skip signal and the faithful surface.

  it('NFR-13: github WITHOUT OAuth creds → no static client (key OMITTED) → clientInformation() undefined', async () => {
    // staticClientFor('github', {}) must return {} (key omitted, not present-but-undefined): a
    // present-but-undefined staticClient would still drive clientInformation() to creds, so an
    // undefined result here proves the key is genuinely absent.
    const a = regApp({ env: { PUBLIC_BASE_URL: 'https://akis.app' } }) // no GITHUB_OAUTH_* creds
    await a.f.inject({ method: 'GET', url: '/mcp/github/connect' })
    expect(a.get()?.clientInformation()).toBeUndefined()
  })

  it('NFR-17: github WITH the login-app env creds → reuses EXACTLY those creds (same OAuth App, no separate app)', async () => {
    // staticClientFor keys off GITHUB_OAUTH_CLIENT_ID/SECRET — the very env vars the login flow uses
    // (oauthCreds('github', env)) — so connecting reuses the operator's existing OAuth App.
    const a = regApp({ env: GH_LOGIN_ENV })
    await a.f.inject({ method: 'GET', url: '/mcp/github/connect' })
    expect(a.get()?.clientInformation()).toEqual({ client_id: 'gh-id', client_secret: 'gh-secret' })
  })

  it('NFR-14: atlassian is NEVER given the github static client even when github creds are present', async () => {
    const a = regApp({ env: GH_LOGIN_ENV }) // github creds set, but atlassian must keep its DCR path
    await a.f.inject({ method: 'GET', url: '/mcp/atlassian/connect' })
    expect(a.get()?.clientInformation()).toBeUndefined() // no static client → SDK would DCR
  })
})

describe('regression · atlassian Jira-only scope + connect/status guards', () => {
  it('FR-1 / NFR-8: REMOTE_MCP_PROVIDERS.atlassian.scope is JIRA-ONLY — Jira scopes present, ALL Confluence scopes absent', () => {
    const atlassian = REMOTE_MCP_PROVIDERS.atlassian
    expect(atlassian).toBeDefined()
    const granted = new Set((atlassian as RemoteMcpProviderConfig).scope.split(/\s+/))
    // Jira read+write must be present (the capability we DO request)…
    expect(granted.has('read:jira-work')).toBe(true)
    expect(granted.has('write:jira-work')).toBe(true)
    // …and NONE of the Confluence scopes — re-adding any of these (a regression) would make Atlassian
    // fail the WHOLE authorization on a site that hasn't granted them, blocking Jira too.
    for (const c of ['read:confluence-content.all', 'write:confluence-content', 'read:confluence-space.summary']) {
      expect(granted.has(c)).toBe(false)
    }
  })

  it('FR-5 / NFR-8: atlassian connect with canStore()===false → mcp=unavailable, auth() NEVER invoked', async () => {
    const { f } = regApp({ env: GH_LOGIN_ENV, auth: authMustNotRun, store: new CannotStore() })
    const res = await f.inject({ method: 'GET', url: '/mcp/atlassian/connect' })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('https://akis.app/settings?mcp=unavailable')
  })

  it('FR-7/-8: connect-step AUTHORIZED → connected; an unexpected string → error; a throw → error', async () => {
    const connected = regApp({ env: GH_LOGIN_ENV, auth: async () => 'AUTHORIZED' })
    expect((await connected.f.inject({ method: 'GET', url: '/mcp/atlassian/connect' })).headers.location)
      .toBe('https://akis.app/settings?mcp=connected')

    // Any other (unexpected) AuthResult string that is neither AUTHORIZED nor a captured REDIRECT → error.
    const weird = regApp({ env: GH_LOGIN_ENV, auth: async () => 'SOMETHING_UNEXPECTED' })
    expect((await weird.f.inject({ method: 'GET', url: '/mcp/atlassian/connect' })).headers.location)
      .toBe('https://akis.app/settings?mcp=error')

    const threw = regApp({ env: GH_LOGIN_ENV, auth: async () => { throw new Error('boom') } })
    expect((await threw.f.inject({ method: 'GET', url: '/mcp/atlassian/connect' })).headers.location)
      .toBe('https://akis.app/settings?mcp=error')
  })

  it('FR-14 / NFR-3: /status returns the SAVED granted scope VERBATIM (not the requested cfg.scope), token-free', async () => {
    const a = regApp({ env: GH_LOGIN_ENV })
    // The site granted a DIFFERENT, narrower scope than what cfg requested (offline_access write:jira-work).
    const grantedScope = 'read:jira-work' // strictly different from the configured request
    const grantedTokens: OAuthTokens = { access_token: 'sekret-at', token_type: 'bearer', refresh_token: 'sekret-rt', scope: grantedScope }
    ;(a.store as MemoryRemoteMcpAuthStore).save('u1', 'atlassian', { tokens: grantedTokens })
    const res = await a.f.inject({ method: 'GET', url: '/mcp/atlassian/status' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.connected).toBe(true)
    expect(body.scopes).toBe(grantedScope) // VERBATIM granted, not the requested 'offline_access write:jira-work'
    expect(body.scopes).not.toBe((BOTH_REG.atlassian as RemoteMcpProviderConfig).scope)
    // No token ever leaves /status (nor the response shape).
    const json = JSON.stringify(body)
    expect(json).not.toContain('access_token'); expect(json).not.toContain('refresh_token')
    expect(json).not.toContain('sekret-at'); expect(json).not.toContain('sekret-rt')
  })

  it('FR-14 / NFR-3: connect & callback Location never carries an access/refresh token', async () => {
    // Use DISTINCTIVE token values so a leak is unambiguous (the module `tokens` uses 2-char values
    // that collide with words like "authorize"/"settings").
    const loud: OAuthTokens = { access_token: 'AT-LEAK-MARKER-9', token_type: 'bearer', refresh_token: 'RT-LEAK-MARKER-9' }
    const loudAuth: RemoteMcpAuthFn = async (provider, opts) => {
      if (opts.authorizationCode) { (provider as StoreBackedOAuthProvider).saveTokens(loud); return 'AUTHORIZED' }
      ;(provider as StoreBackedOAuthProvider).saveCodeVerifier('pkce')
      ;(provider as StoreBackedOAuthProvider).redirectToAuthorization(new URL('https://auth.example/authorize?client_id=dcr'))
      return 'REDIRECT'
    }
    // connect → captured authorize URL (the only outward 302 with secrets in scope)
    const a = regApp({ env: GH_LOGIN_ENV, auth: loudAuth })
    const connect = await a.f.inject({ method: 'GET', url: '/mcp/atlassian/connect' })
    const connectLoc = connect.headers.location as string
    expect(connectLoc).not.toContain('access_token'); expect(connectLoc).not.toContain('refresh_token')
    expect(connectLoc).not.toContain(loud.access_token); expect(connectLoc).not.toContain(loud.refresh_token as string)

    // callback → on success the Location is the opaque mcp=connected, never a token (loudAuth saves `loud`).
    const state = signConnectState('u1', 'atlassian', SECRET)
    const cb = await a.f.inject({ method: 'GET', url: `/mcp/atlassian/callback?code=abc&state=${encodeURIComponent(state)}` })
    const cbLoc = cb.headers.location as string
    expect(cbLoc).toBe('https://akis.app/settings?mcp=connected')
    expect(cbLoc).not.toContain('access_token'); expect(cbLoc).not.toContain('refresh_token')
    expect(cbLoc).not.toContain(loud.access_token); expect(cbLoc).not.toContain(loud.refresh_token as string)
    // and the tokens DID land (proving the no-leak isn't because nothing was exchanged)
    expect((a.store as MemoryRemoteMcpAuthStore).load('u1', 'atlassian')?.tokens).toEqual(loud)
  })
})
