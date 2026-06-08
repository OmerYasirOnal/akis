import { describe, it, expect } from 'vitest'
import {
  signState, verifyState, authorizeUrl, exchangeCode, fetchProfile,
  configuredProviders, oauthCreds, isOAuthProvider, type HttpFetch,
} from '../../src/auth/oauth.js'

const ok = (body: unknown): ReturnType<HttpFetch> => Promise.resolve({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) })

describe('oauth state (HMAC, stateless)', () => {
  const secret = 's3cr3t'
  it('round-trips and binds the provider', () => {
    expect(verifyState(signState('github', secret, 600, 1000), secret, 1100)).toBe('github')
  })
  it('rejects a tampered/foreign-secret/expired state', () => {
    const st = signState('github', secret, 600, 1000)
    expect(verifyState(st, 'other', 1100)).toBeUndefined()
    expect(verifyState(st + 'x', secret, 1100)).toBeUndefined()
    expect(verifyState(st, secret, 9999)).toBeUndefined() // expired
    expect(verifyState('garbage', secret, 1100)).toBeUndefined()
  })
})

describe('oauth config', () => {
  it('detects configured providers from env', () => {
    expect(configuredProviders({})).toEqual([])
    expect(configuredProviders({ GITHUB_OAUTH_CLIENT_ID: 'a', GITHUB_OAUTH_CLIENT_SECRET: 'b' })).toEqual(['github'])
    expect(oauthCreds('github', { GITHUB_OAUTH_CLIENT_ID: 'a', GITHUB_OAUTH_CLIENT_SECRET: 'b' })).toEqual({ clientId: 'a', clientSecret: 'b' })
    expect(oauthCreds('google', {})).toBeUndefined()
  })
  it('isOAuthProvider guards unknown providers', () => {
    expect(isOAuthProvider('github')).toBe(true)
    expect(isOAuthProvider('facebook')).toBe(false)
  })
})

describe('authorizeUrl', () => {
  it('includes client_id, redirect_uri, scope, state, response_type', () => {
    const url = new URL(authorizeUrl('google', 'cid', 'https://app/cb', 'st8'))
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('client_id')).toBe('cid')
    expect(url.searchParams.get('redirect_uri')).toBe('https://app/cb')
    expect(url.searchParams.get('state')).toBe('st8')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('scope')).toContain('email')
  })
})

describe('exchangeCode', () => {
  it('returns the access token + granted scopes', async () => {
    const http: HttpFetch = async () => (await ok({ access_token: 'tok123' }))
    // exchangeCode now returns {token, scopes} (scopes drive the per-user connect flow);
    // an absent scope fails closed to [] rather than throwing.
    expect(await exchangeCode('github', { code: 'c', clientId: 'i', clientSecret: 's', redirectUri: 'r' }, http)).toEqual({ token: 'tok123', scopes: [] })
  })
  it('throws when the token response has no token / is not ok', async () => {
    await expect(exchangeCode('github', { code: 'c', clientId: 'i', clientSecret: 's', redirectUri: 'r' }, async () => ok({}))).rejects.toThrow()
    await expect(exchangeCode('google', { code: 'c', clientId: 'i', clientSecret: 's', redirectUri: 'r' }, async () => ({ ok: false, status: 400, json: async () => ({}), text: async () => '' }))).rejects.toThrow(/token exchange failed/)
  })
})

describe('fetchProfile', () => {
  it('normalizes a GitHub profile (falling back to /user/emails for a private email)', async () => {
    const http: HttpFetch = async (url) => {
      if (url.endsWith('/user')) return ok({ id: 42, login: 'ada', name: 'Ada', email: null })
      if (url.endsWith('/user/emails')) return ok([{ email: 'ada@gh.dev', primary: true, verified: true }])
      throw new Error('unexpected ' + url)
    }
    expect(await fetchProfile('github', 'tok', http)).toEqual({ externalId: 'github:42', email: 'ada@gh.dev', name: 'Ada' })
  })
  it('normalizes a Google profile', async () => {
    const http: HttpFetch = async () => ok({ sub: 'g-1', email: 'ada@goog.dev', name: 'Ada G', email_verified: true })
    expect(await fetchProfile('google', 'tok', http)).toEqual({ externalId: 'google:g-1', email: 'ada@goog.dev', name: 'Ada G' })
  })
  it('returns the GitHub avatar_url as avatarUrl (login projection)', async () => {
    const http: HttpFetch = async (url) => {
      if (url.endsWith('/user')) return ok({ id: 7, login: 'ada', name: 'Ada', email: 'ada@gh.dev', avatar_url: 'https://avatars.githubusercontent.com/u/7' })
      throw new Error('unexpected ' + url)
    }
    expect(await fetchProfile('github', 'tok', http)).toEqual({ externalId: 'github:7', email: 'ada@gh.dev', name: 'Ada', avatarUrl: 'https://avatars.githubusercontent.com/u/7' })
  })
  it('returns the Google picture as avatarUrl (login projection)', async () => {
    const http: HttpFetch = async () => ok({ sub: 'g-9', email: 'ada@goog.dev', name: 'Ada G', email_verified: true, picture: 'https://lh3.googleusercontent.com/a/ada' })
    expect(await fetchProfile('google', 'tok', http)).toEqual({ externalId: 'google:g-9', email: 'ada@goog.dev', name: 'Ada G', avatarUrl: 'https://lh3.googleusercontent.com/a/ada' })
  })
  it('omits avatarUrl entirely when the provider returns none (exactOptionalPropertyTypes — no explicit undefined)', async () => {
    const http: HttpFetch = async () => ok({ sub: 'g-10', email: 'noavatar@goog.dev', email_verified: true })
    const p = await fetchProfile('google', 'tok', http)
    expect('avatarUrl' in p).toBe(false)
  })
  it('throws on a profile missing id/email', async () => {
    await expect(fetchProfile('google', 'tok', async () => ok({ name: 'x' }))).rejects.toThrow()
  })
  it('rejects a Google profile whose email is not verified (account-takeover guard)', async () => {
    await expect(fetchProfile('google', 'tok', async () => ok({ sub: 'g-2', email: 'victim@gmail.com', email_verified: false }))).rejects.toThrow(/not verified/)
    // missing flag is also treated as unverified
    await expect(fetchProfile('google', 'tok', async () => ok({ sub: 'g-3', email: 'x@y.dev' }))).rejects.toThrow(/not verified/)
  })
})
