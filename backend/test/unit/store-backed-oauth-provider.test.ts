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
