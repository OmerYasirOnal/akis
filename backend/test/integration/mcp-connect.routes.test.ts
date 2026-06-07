import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { registerMcpConnectRoutes, mcpTransportFor, type RemoteMcpAuthFn, type RemoteMcpProviderConfig } from '../../src/api/mcpConnect.routes.js'
import { MemoryRemoteMcpAuthStore, StoreBackedOAuthProvider } from '../../src/agent/mcp/StoreBackedOAuthProvider.js'
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'

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
    store, env: ENV, providers: PROVIDERS,
    auth: opts.auth ?? fakeAuth,
    userIdOf: async () => opts.userId,
  })
  return { f, store }
}

describe('mcp connect routes', () => {
  it('connect → 302 to the captured authorize URL (DCR + PKCE driven by the SDK)', async () => {
    const { f } = app({ userId: 'u1' })
    const res = await f.inject({ method: 'GET', url: '/mcp/atlassian/connect' })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('https://auth.example/authorize?client_id=dcr&code_challenge=x')
  })

  it('connect requires auth (401) and rejects an unknown provider', async () => {
    expect((await app({}).f.inject({ method: 'GET', url: '/mcp/atlassian/connect' })).statusCode).toBe(401)
    const res = await app({ userId: 'u1' }).f.inject({ method: 'GET', url: '/mcp/nope/connect' })
    expect(res.headers.location).toBe('https://akis.app/settings?mcp=unknown')
  })

  it('callback exchanges the code → tokens stored, verifier cleared, redirect connected', async () => {
    const { f, store } = app({ userId: 'u1' })
    const res = await f.inject({ method: 'GET', url: '/mcp/atlassian/callback?code=abc&state=s' })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('https://akis.app/settings?mcp=connected')
    expect(store.load('u1', 'atlassian')?.tokens).toEqual(tokens)
    expect(store.load('u1', 'atlassian')?.codeVerifier).toBeUndefined() // spent verifier cleared
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
