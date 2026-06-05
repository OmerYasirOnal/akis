import { describe, it, expect } from 'vitest'
import { exchangeCode, type HttpFetch } from '../../src/auth/oauth.js'

const tokenResponse = (body: unknown): ReturnType<HttpFetch> =>
  Promise.resolve({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) })

const ARGS = { code: 'abc', clientId: 'cid', clientSecret: 'csecret', redirectUri: 'http://x/cb' }

describe('exchangeCode returns {token, scopes}', () => {
  it('parses a space-delimited scope', async () => {
    const http: HttpFetch = async () => tokenResponse({ access_token: 'tok', scope: 'repo read:user' })
    const r = await exchangeCode('github', ARGS, http)
    expect(r).toEqual({ token: 'tok', scopes: ['repo', 'read:user'] })
  })

  it('parses a comma-delimited scope', async () => {
    const http: HttpFetch = async () => tokenResponse({ access_token: 'tok', scope: 'repo,gist' })
    const r = await exchangeCode('github', ARGS, http)
    expect(r.scopes).toEqual(['repo', 'gist'])
  })

  it('fails closed to [] when scope is absent (no throw)', async () => {
    const http: HttpFetch = async () => tokenResponse({ access_token: 'tok' })
    const r = await exchangeCode('github', ARGS, http)
    expect(r).toEqual({ token: 'tok', scopes: [] })
  })

  it('throws (token-free) when the token endpoint fails or omits the token', async () => {
    const failing: HttpFetch = async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => '' })
    await expect(exchangeCode('github', ARGS, failing)).rejects.toThrow()
    const noToken: HttpFetch = async () => tokenResponse({ scope: 'repo' })
    await expect(exchangeCode('github', ARGS, noToken)).rejects.toThrow()
  })
})
