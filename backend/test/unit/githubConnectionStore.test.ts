import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync, rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { JsonFileGitHubConnectionStore, GitHubConnectionMemoryStore } from '../../src/keys/GitHubConnectionStore.js'

const MASTER = '0'.repeat(64) // 32 bytes hex
const TOKEN = 'ghp_supersecrettoken_value_1234567890'

// Each test gets its OWN tmp file under os.tmpdir() — NEVER the real ~/.config/akis.
const tmpFiles: string[] = []
function tmpStorePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'akis-ghconn-'))
  tmpFiles.push(dir)
  return join(dir, 'github-connections.json')
}
afterEach(() => { for (const d of tmpFiles.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('JsonFileGitHubConnectionStore', () => {
  it('round-trips a stored token via getToken', () => {
    const s = new JsonFileGitHubConnectionStore(tmpStorePath(), MASTER)
    s.set('user-1', { accessToken: TOKEN, username: 'ada', scopes: ['repo'], repo: 'ada/app' })
    expect(s.getToken('user-1')).toBe(TOKEN)
  })

  it('encrypts the token at rest — the on-disk file holds NO plaintext token', () => {
    const file = tmpStorePath()
    const s = new JsonFileGitHubConnectionStore(file, MASTER)
    s.set('user-1', { accessToken: TOKEN, username: 'ada', scopes: ['repo'], repo: 'ada/app' })
    const raw = readFileSync(file, 'utf8')
    expect(raw.includes(TOKEN)).toBe(false)
    // The non-secret metadata IS in the clear (like KeyStore's last4/updatedAt).
    expect(raw).toContain('ada/app')
    expect(raw).toContain('"repo"')
  })

  it('status returns the non-secret projection — never the token', () => {
    const s = new JsonFileGitHubConnectionStore(tmpStorePath(), MASTER)
    s.set('user-1', { accessToken: TOKEN, username: 'ada', scopes: ['repo'], repo: 'ada/app' })
    const st = s.status('user-1')
    expect(st).toEqual({ username: 'ada', scopes: ['repo'], repo: 'ada/app', connectedAt: expect.any(String) })
    expect(JSON.stringify(st)).not.toContain(TOKEN)
  })

  it('survives a restart (reload from file)', () => {
    const file = tmpStorePath()
    new JsonFileGitHubConnectionStore(file, MASTER).set('user-1', { accessToken: TOKEN, username: 'ada', scopes: ['repo'], repo: 'ada/app' })
    const reopened = new JsonFileGitHubConnectionStore(file, MASTER)
    expect(reopened.getToken('user-1')).toBe(TOKEN)
    expect(reopened.status('user-1')?.repo).toBe('ada/app')
  })

  it('an undecryptable row (wrong master) reads as ABSENT — no throw', () => {
    const file = tmpStorePath()
    new JsonFileGitHubConnectionStore(file, MASTER).set('user-1', { accessToken: TOKEN, username: 'ada', scopes: ['repo'], repo: 'ada/app' })
    const wrong = new JsonFileGitHubConnectionStore(file, '1'.repeat(64))
    expect(wrong.getToken('user-1')).toBeUndefined()
    expect(wrong.status('user-1')).toBeUndefined()
  })

  it('remove clears the connection', () => {
    const s = new JsonFileGitHubConnectionStore(tmpStorePath(), MASTER)
    s.set('user-1', { accessToken: TOKEN, username: 'ada', scopes: ['repo'], repo: 'ada/app' })
    s.remove('user-1')
    expect(s.getToken('user-1')).toBeUndefined()
    expect(s.status('user-1')).toBeUndefined()
  })

  it('canStore reflects master-key usability (true for a valid key, false for empty/short)', () => {
    expect(new JsonFileGitHubConnectionStore(tmpStorePath(), MASTER).canStore()).toBe(true)
    expect(new JsonFileGitHubConnectionStore(tmpStorePath(), Buffer.alloc(32, 7).toString('base64')).canStore()).toBe(true)
    expect(new JsonFileGitHubConnectionStore(tmpStorePath(), '').canStore()).toBe(false)
    expect(new JsonFileGitHubConnectionStore(tmpStorePath(), 'too-short').canStore()).toBe(false)
  })
})

describe('GitHubConnectionMemoryStore', () => {
  it('round-trips and canStore is always true', () => {
    const s = new GitHubConnectionMemoryStore()
    s.set('u', { accessToken: TOKEN, username: 'ada', scopes: ['repo'], repo: 'ada/app' })
    expect(s.getToken('u')).toBe(TOKEN)
    expect(s.status('u')?.repo).toBe('ada/app')
    expect(s.canStore()).toBe(true)
    s.remove('u')
    expect(s.status('u')).toBeUndefined()
  })
})
