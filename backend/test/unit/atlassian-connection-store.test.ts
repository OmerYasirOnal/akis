import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonFileAtlassianConnectionStore, AtlassianConnectionMemoryStore, type AtlassianConnectionInput } from '../../src/keys/AtlassianConnectionStore.js'

const KEY = 'a'.repeat(64) // 32 bytes hex
const input = (over: Partial<AtlassianConnectionInput> = {}): AtlassianConnectionInput => ({
  accessToken: 'access-tok', refreshToken: 'refresh-tok', cloudId: 'cloud-1', siteUrl: 'https://org.atlassian.net',
  scopes: ['read:confluence-content.all', 'write:confluence-content'], expiresInSec: 3600, ...over,
})

describe('JsonFileAtlassianConnectionStore (encrypted at rest)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'akis-atl-'))
  const file = join(dir, 'atl.json')

  it('round-trips tokens, exposes ONLY non-secret status, and persists to disk encrypted', () => {
    let t = 1_000_000
    const s = new JsonFileAtlassianConnectionStore(file, KEY, () => t)
    s.set('u1', input())
    expect(s.getTokens('u1')).toEqual({ accessToken: 'access-tok', refreshToken: 'refresh-tok' })
    const st = s.status('u1')!
    expect(st.cloudId).toBe('cloud-1')
    expect(st.siteUrl).toBe('https://org.atlassian.net')
    expect(st.expiresAt).toBe(new Date(1_000_000 + 3600_000).toISOString())
    // No plaintext token on the public projection.
    expect(JSON.stringify(st)).not.toContain('access-tok')
    expect(JSON.stringify(st)).not.toContain('refresh-tok')
    // The file holds NO plaintext token (only ciphertext + non-secret metadata).
    const raw = readFileSync(file, 'utf8')
    expect(raw).not.toContain('access-tok')
    expect(raw).not.toContain('refresh-tok')
  })

  it('survives a reload (new instance reads the persisted, encrypted row)', () => {
    const a = new JsonFileAtlassianConnectionStore(file, KEY)
    a.set('u2', input({ accessToken: 'A2', refreshToken: 'R2', cloudId: 'c2' }))
    const b = new JsonFileAtlassianConnectionStore(file, KEY)
    expect(b.getTokens('u2')).toEqual({ accessToken: 'A2', refreshToken: 'R2' })
    expect(b.status('u2')?.cloudId).toBe('c2')
  })

  it('a row under a DIFFERENT master fails closed (undecryptable → absent, no throw)', () => {
    const a = new JsonFileAtlassianConnectionStore(file, KEY)
    a.set('u3', input())
    const wrong = new JsonFileAtlassianConnectionStore(file, 'b'.repeat(64))
    expect(wrong.getTokens('u3')).toBeUndefined()
    expect(wrong.status('u3')).toBeUndefined() // not advertised as connected
  })

  it('remove deletes the row; canStore reflects a usable master', () => {
    const s = new JsonFileAtlassianConnectionStore(file, KEY)
    s.set('u4', input())
    s.remove('u4')
    expect(s.getTokens('u4')).toBeUndefined()
    expect(s.canStore()).toBe(true)
    expect(new JsonFileAtlassianConnectionStore(file, '').canStore()).toBe(false) // no master
  })

  rmSync(dir, { recursive: true, force: true })
})

describe('AtlassianConnectionMemoryStore', () => {
  it('round-trips tokens + status without encryption (canStore always true)', () => {
    const s = new AtlassianConnectionMemoryStore(() => 5_000)
    s.set('u', input())
    expect(s.getTokens('u')).toEqual({ accessToken: 'access-tok', refreshToken: 'refresh-tok' })
    expect(s.status('u')?.expiresAt).toBe(new Date(5_000 + 3600_000).toISOString())
    expect(s.canStore()).toBe(true)
    s.remove('u')
    expect(s.status('u')).toBeUndefined()
  })
})
