import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  JsonFilePublishProfileStore,
  PublishProfileMemoryStore,
  keyFingerprint,
} from '../../src/keys/PublishProfileStore.js'

const MASTER = '0'.repeat(64) // 32 bytes hex
// A realistic-looking (but fake) PEM. The full block is the secret — no part may hit disk.
const KEY = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAA_THIS_IS_A_FAKE_TEST_KEY_NOT_REAL_SECRET_0000',
  'AAAABmFrZS1 rZXktbWF0ZXJpYWwtZm9yLXVuaXQtdGVzdHMtb25seQ==',
  '-----END OPENSSH PRIVATE KEY-----',
].join('\n')

const INPUT = { host: 'oci.example.com', sshUser: 'ubuntu', sshPrivateKey: KEY, targetDir: '/home/ubuntu/app', appPort: 8080, publicUrl: 'http://oci.example.com:8080' }

const tmpFiles: string[] = []
function tmpStorePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'akis-pubprof-'))
  tmpFiles.push(dir)
  return join(dir, 'publish-profiles.json')
}
afterEach(() => { for (const d of tmpFiles.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('JsonFilePublishProfileStore', () => {
  it('round-trips a stored key via getProfile', () => {
    const s = new JsonFilePublishProfileStore(tmpStorePath(), MASTER)
    s.set('user-1', INPUT)
    expect(s.getProfile('user-1')?.sshPrivateKey).toBe(KEY)
    expect(s.getProfile('user-1')?.appPort).toBe(8080)
  })

  it('encrypts the key at rest — the on-disk file holds NO plaintext key bytes', () => {
    const file = tmpStorePath()
    const s = new JsonFilePublishProfileStore(file, MASTER)
    s.set('user-1', INPUT)
    const raw = readFileSync(file, 'utf8')
    // Not even a recognizable slice of the PEM body may appear in the clear.
    expect(raw.includes('THIS_IS_A_FAKE_TEST_KEY')).toBe(false)
    expect(raw.includes('BEGIN OPENSSH PRIVATE KEY')).toBe(false)
    // The non-secret metadata IS in the clear (like the GitHub store's repo/connectedAt).
    expect(raw).toContain('/home/ubuntu/app')
    expect(raw).toContain('oci.example.com')
  })

  it('status returns the non-secret projection + fingerprint — never the key', () => {
    const s = new JsonFilePublishProfileStore(tmpStorePath(), MASTER)
    s.set('user-1', INPUT)
    const st = s.status('user-1')
    expect(st).toEqual({
      host: 'oci.example.com', sshUser: 'ubuntu', targetDir: '/home/ubuntu/app',
      appPort: 8080, publicUrl: 'http://oci.example.com:8080',
      keyFingerprint: keyFingerprint(KEY), updatedAt: expect.any(String),
    })
    expect(JSON.stringify(st)).not.toContain('PRIVATE KEY')
    expect(JSON.stringify(st)).not.toContain('THIS_IS_A_FAKE_TEST_KEY')
  })

  it('the fingerprint is stable + key-free', () => {
    const fp = keyFingerprint(KEY)
    expect(fp).toBe(keyFingerprint(KEY)) // deterministic
    expect(fp).not.toContain('PRIVATE KEY')
    expect(fp.length).toBeGreaterThan(0)
  })

  it('survives a restart (reload from file)', () => {
    const file = tmpStorePath()
    new JsonFilePublishProfileStore(file, MASTER).set('user-1', INPUT)
    const reopened = new JsonFilePublishProfileStore(file, MASTER)
    expect(reopened.getProfile('user-1')?.sshPrivateKey).toBe(KEY)
    expect(reopened.status('user-1')?.targetDir).toBe('/home/ubuntu/app')
  })

  it('a row encrypted under a DIFFERENT master reads as ABSENT — no throw (the #120 regression)', () => {
    const file = tmpStorePath()
    new JsonFilePublishProfileStore(file, MASTER).set('user-1', INPUT)
    const wrong = new JsonFilePublishProfileStore(file, '1'.repeat(64))
    expect(wrong.getProfile('user-1')).toBeUndefined()
    expect(wrong.status('user-1')).toBeUndefined() // usability, not presence
  })

  it('a row encrypted for one user does NOT decrypt for another (AAD cross-user binding)', () => {
    // Move user-A's encrypted row under user-B's key — the AAD discriminator (the uid) is part of
    // the GCM AAD, so decrypt fails and getProfile/status fail-close to undefined. The file is
    // rewritten BEFORE the reading store is constructed (load() reads the file at construction).
    const file = tmpStorePath()
    new JsonFilePublishProfileStore(file, MASTER).set('user-A', INPUT)
    const rows = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    rows['user-B'] = rows['user-A'] // same ciphertext, different uid (different AAD)
    delete rows['user-A']
    writeFileSync(file, JSON.stringify(rows, null, 2))
    const fresh = new JsonFilePublishProfileStore(file, MASTER)
    expect(fresh.getProfile('user-B')).toBeUndefined()
    expect(fresh.status('user-B')).toBeUndefined()
  })

  it('remove clears the profile (no stale decryptable row)', () => {
    const s = new JsonFilePublishProfileStore(tmpStorePath(), MASTER)
    s.set('user-1', INPUT)
    s.remove('user-1')
    expect(s.getProfile('user-1')).toBeUndefined()
    expect(s.status('user-1')).toBeUndefined()
  })

  it('canStore reflects master-key usability (true for a valid key, false for empty/short)', () => {
    expect(new JsonFilePublishProfileStore(tmpStorePath(), MASTER).canStore()).toBe(true)
    expect(new JsonFilePublishProfileStore(tmpStorePath(), Buffer.alloc(32, 7).toString('base64')).canStore()).toBe(true)
    expect(new JsonFilePublishProfileStore(tmpStorePath(), '').canStore()).toBe(false)
    expect(new JsonFilePublishProfileStore(tmpStorePath(), 'too-short').canStore()).toBe(false)
  })

  it('a master ROTATED after storing reads as present:false (usability, not presence)', () => {
    const file = tmpStorePath()
    new JsonFilePublishProfileStore(file, MASTER).set('user-1', INPUT)
    // A different master (key rotation) can no longer decrypt the row → no profile.
    const rotated = new JsonFilePublishProfileStore(file, 'a'.repeat(64))
    expect(rotated.status('user-1')).toBeUndefined()
  })
})

describe('PublishProfileMemoryStore', () => {
  it('round-trips and canStore is always true', () => {
    const s = new PublishProfileMemoryStore()
    s.set('u', INPUT)
    expect(s.getProfile('u')?.sshPrivateKey).toBe(KEY)
    expect(s.status('u')?.targetDir).toBe('/home/ubuntu/app')
    expect(s.status('u')?.keyFingerprint).toBe(keyFingerprint(KEY))
    expect(JSON.stringify(s.status('u'))).not.toContain('PRIVATE KEY')
    expect(s.canStore()).toBe(true)
    s.remove('u')
    expect(s.status('u')).toBeUndefined()
  })

  it('omits an absent optional appPort/publicUrl from status (no explicit undefined)', () => {
    const s = new PublishProfileMemoryStore()
    s.set('u', { host: 'h.example.com', sshUser: 'opc', sshPrivateKey: KEY, targetDir: '/home/opc/app' })
    const st = s.status('u')!
    expect('appPort' in st).toBe(false)
    expect('publicUrl' in st).toBe(false)
  })
})
