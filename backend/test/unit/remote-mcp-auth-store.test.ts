import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonFileRemoteMcpAuthStore } from '../../src/keys/JsonFileRemoteMcpAuthStore.js'
import type { OAuthTokens, OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js'

const KEY = 'a'.repeat(64)
const clientInfo: OAuthClientInformationFull = { client_id: 'dcr-1', client_secret: 'shh', redirect_uris: ['https://akis/cb'] }
const tokens: OAuthTokens = { access_token: 'at-secret', token_type: 'bearer', refresh_token: 'rt-secret', expires_in: 3600 }

describe('JsonFileRemoteMcpAuthStore (encrypted at rest, per user+provider)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'akis-mcp-auth-'))
  const file = join(dir, 'mcp-auth.json')

  it('round-trips the record + persists ONLY ciphertext (no token/secret in plaintext on disk)', () => {
    const s = new JsonFileRemoteMcpAuthStore(file, KEY)
    s.save('u1', 'atlassian', { clientInfo })
    s.save('u1', 'atlassian', { tokens })
    s.save('u1', 'atlassian', { codeVerifier: 'pkce-verifier' })
    expect(s.load('u1', 'atlassian')).toEqual({ clientInfo, tokens, codeVerifier: 'pkce-verifier' })
    const raw = readFileSync(file, 'utf8')
    for (const secret of ['at-secret', 'rt-secret', 'pkce-verifier', 'shh', 'dcr-1']) expect(raw).not.toContain(secret)
  })

  it('survives reload (new instance reads the encrypted row)', () => {
    const a = new JsonFileRemoteMcpAuthStore(file, KEY)
    a.save('u2', 'github', { clientInfo, tokens })
    const b = new JsonFileRemoteMcpAuthStore(file, KEY)
    expect(b.load('u2', 'github')).toEqual({ clientInfo, tokens })
  })

  it('isolates by (user, provider)', () => {
    const s = new JsonFileRemoteMcpAuthStore(file, KEY)
    s.save('u3', 'atlassian', { tokens })
    expect(s.load('u3', 'github')).toBeUndefined()   // different provider
    expect(s.load('u4', 'atlassian')).toBeUndefined() // different user
  })

  it('clearVerifier drops only the PKCE verifier; explicit-undefined clears a field', () => {
    const s = new JsonFileRemoteMcpAuthStore(file, KEY)
    s.save('u5', 'atlassian', { clientInfo, tokens, codeVerifier: 'v' })
    s.clearVerifier('u5', 'atlassian')
    expect(s.load('u5', 'atlassian')).toEqual({ clientInfo, tokens }) // verifier gone, rest kept
    s.save('u5', 'atlassian', { tokens: undefined })
    expect(s.load('u5', 'atlassian')).toEqual({ clientInfo }) // tokens cleared
  })

  it('a row under a DIFFERENT master fails CLOSED (undecryptable → absent, no throw)', () => {
    const a = new JsonFileRemoteMcpAuthStore(file, KEY)
    a.save('u6', 'atlassian', { tokens })
    const wrong = new JsonFileRemoteMcpAuthStore(file, 'b'.repeat(64))
    expect(wrong.load('u6', 'atlassian')).toBeUndefined()
  })

  it('remove deletes the connection; canStore reflects a usable master', () => {
    const s = new JsonFileRemoteMcpAuthStore(file, KEY)
    s.save('u7', 'atlassian', { tokens })
    s.remove('u7', 'atlassian')
    expect(s.load('u7', 'atlassian')).toBeUndefined()
    expect(s.canStore()).toBe(true)
    expect(new JsonFileRemoteMcpAuthStore(file, '').canStore()).toBe(false)
  })

  rmSync(dir, { recursive: true, force: true })
})
