import { describe, it, expect } from 'vitest'
import { StoreBackedOAuthProvider, MemoryRemoteMcpAuthStore } from '../../src/agent/mcp/StoreBackedOAuthProvider.js'
import type { OAuthTokens, OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js'

const clientInfo: OAuthClientInformationFull = { client_id: 'dcr-123', redirect_uris: ['https://akis/cb'] }
const tokens: OAuthTokens = { access_token: 'at', token_type: 'bearer', refresh_token: 'rt', expires_in: 3600 }

function make(store = new MemoryRemoteMcpAuthStore()) {
  const p = new StoreBackedOAuthProvider({
    userId: 'u1', provider: 'atlassian', redirectUrl: 'https://akis.app/mcp/atlassian/callback',
    scope: 'offline_access read:jira-work write:jira-work', store,
  })
  return { p, store }
}

describe('StoreBackedOAuthProvider — server-side OAuth/DCR adapter', () => {
  it('exposes a public-client metadata with the callback redirect_uri + scope', () => {
    const { p } = make()
    expect(p.redirectUrl).toBe('https://akis.app/mcp/atlassian/callback')
    const m = p.clientMetadata
    expect(m.redirect_uris).toEqual(['https://akis.app/mcp/atlassian/callback'])
    expect(m.token_endpoint_auth_method).toBe('none') // PKCE public client
    expect(m.grant_types).toContain('refresh_token')
    expect(m.scope).toContain('offline_access')
  })

  it('DCR: saveClientInformation persists, clientInformation reads it back', () => {
    const { p } = make()
    expect(p.clientInformation()).toBeUndefined()
    p.saveClientInformation(clientInfo)
    expect(p.clientInformation()).toEqual(clientInfo)
  })

  it('tokens round-trip via saveTokens (the SDK persists rotated tokens here on every refresh)', () => {
    const { p } = make()
    expect(p.tokens()).toBeUndefined()
    p.saveTokens(tokens)
    expect(p.tokens()).toEqual(tokens)
  })

  it('PKCE: saveCodeVerifier persists; codeVerifier reads it; codeVerifier THROWS when absent', () => {
    const { p } = make()
    expect(() => p.codeVerifier()).toThrow(/no PKCE code_verifier/)
    p.saveCodeVerifier('verifier-xyz')
    expect(p.codeVerifier()).toBe('verifier-xyz')
  })

  it('CAPTURES the authorization URL instead of redirecting server-side', () => {
    const { p } = make()
    expect(p.capturedAuthorizationUrl).toBeUndefined()
    p.redirectToAuthorization(new URL('https://auth.atlassian.com/authorize?x=1'))
    expect(p.capturedAuthorizationUrl?.toString()).toBe('https://auth.atlassian.com/authorize?x=1')
  })

  it('invalidateCredentials clears the right material (verifier / tokens / all)', () => {
    const { p } = make()
    p.saveClientInformation(clientInfo); p.saveTokens(tokens); p.saveCodeVerifier('v')
    p.invalidateCredentials('verifier')
    expect(() => p.codeVerifier()).toThrow() // verifier gone
    expect(p.tokens()).toEqual(tokens)        // tokens kept
    p.invalidateCredentials('all')
    expect(p.tokens()).toBeUndefined()
    expect(p.clientInformation()).toBeUndefined()
  })

  it('store isolates by (userId, provider): another user/provider sees nothing', () => {
    const store = new MemoryRemoteMcpAuthStore()
    make(store).p.saveTokens(tokens) // u1/atlassian
    const other = new StoreBackedOAuthProvider({ userId: 'u2', provider: 'atlassian', redirectUrl: 'x', scope: 's', store })
    const otherProvider = new StoreBackedOAuthProvider({ userId: 'u1', provider: 'github', redirectUrl: 'x', scope: 's', store })
    expect(other.tokens()).toBeUndefined()         // different user
    expect(otherProvider.tokens()).toBeUndefined() // different provider
  })
})

describe('StoreBackedOAuthProvider — STATIC client (GitHub, no DCR)', () => {
  function makeStatic(store = new MemoryRemoteMcpAuthStore()) {
    const p = new StoreBackedOAuthProvider({
      userId: 'u1', provider: 'github', redirectUrl: 'https://akis.app/mcp/github/callback',
      scope: 'repo read:org read:user', store,
      staticClient: { clientId: 'gh-client', clientSecret: 'gh-secret' },
    })
    return { p, store }
  }

  it('clientInformation() returns the STATIC client (so the SDK skips DCR / registerClient)', () => {
    const { p, store } = makeStatic()
    // The store has NO clientInfo (no DCR ran), yet clientInformation() is populated from the static
    // creds — this is exactly the non-undefined return that makes the SDK bypass registerClient.
    expect(store.load('u1', 'github')?.clientInfo).toBeUndefined()
    expect(p.clientInformation()).toEqual({ client_id: 'gh-client', client_secret: 'gh-secret' })
  })

  it('saveClientInformation is a NO-OP with a static client — never overwrites the fixed creds', () => {
    const { p, store } = makeStatic()
    // Even if the SDK (defensively) tried to persist a registered client, it must not clobber the
    // static creds nor write to the store.
    p.saveClientInformation({ client_id: 'dcr-should-not-win', redirect_uris: ['https://akis/cb'] })
    expect(store.load('u1', 'github')?.clientInfo).toBeUndefined()
    expect(p.clientInformation()).toEqual({ client_id: 'gh-client', client_secret: 'gh-secret' })
  })

  it('tokens still round-trip via the store (only the CLIENT is static, not the tokens)', () => {
    const { p, store } = makeStatic()
    expect(p.tokens()).toBeUndefined()
    p.saveTokens(tokens)
    expect(p.tokens()).toEqual(tokens)
    expect(store.load('u1', 'github')?.tokens).toEqual(tokens)
  })

  it('WITHOUT a static client the store-backed (DCR) behavior is unchanged', () => {
    // Same provider, NO staticClient → falls back to the store-backed clientInfo (the Atlassian path).
    const store = new MemoryRemoteMcpAuthStore()
    const p = new StoreBackedOAuthProvider({
      userId: 'u1', provider: 'github', redirectUrl: 'https://akis.app/mcp/github/callback',
      scope: 'repo', store,
    })
    expect(p.clientInformation()).toBeUndefined() // no DCR client yet, no static client
    p.saveClientInformation(clientInfo)           // DCR persists
    expect(p.clientInformation()).toEqual(clientInfo)
    expect(store.load('u1', 'github')?.clientInfo).toEqual(clientInfo)
  })
})
