import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { JsonFileKeyStore } from '../../src/keys/KeyStore.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MASTER = '0'.repeat(64)
let dir: string
let file: string

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'akis-ks-')); file = join(dir, 'keys.json') })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('JsonFileKeyStore', () => {
  it('set then get round-trips the key', () => {
    const ks = new JsonFileKeyStore(file, MASTER, () => '2026-06-01T00:00:00Z')
    ks.set('anthropic', 'sk-ant-12345')
    expect(ks.get('anthropic')).toBe('sk-ant-12345')
  })
  it('status exposes only last4 + configured, never the key', () => {
    const ks = new JsonFileKeyStore(file, MASTER, () => '2026-06-01T00:00:00Z')
    ks.set('anthropic', 'sk-ant-12345')
    const st = ks.status('anthropic')
    expect(st).toEqual({ provider: 'anthropic', configured: true, last4: '2345', updatedAt: '2026-06-01T00:00:00Z' })
    expect(JSON.stringify(st)).not.toContain('sk-ant-12345')
  })
  it('reports not-configured for an unknown provider', () => {
    const ks = new JsonFileKeyStore(file, MASTER)
    expect(ks.status('openai')).toEqual({ provider: 'openai', configured: false })
  })
  it('remove deletes the key', () => {
    const ks = new JsonFileKeyStore(file, MASTER)
    ks.set('openai', 'sk-x'); ks.remove('openai')
    expect(ks.get('openai')).toBeUndefined()
  })
  it('survives reload (new instance, same file)', () => {
    new JsonFileKeyStore(file, MASTER).set('google', 'AIza-secret')
    const ks2 = new JsonFileKeyStore(file, MASTER)
    expect(ks2.get('google')).toBe('AIza-secret')
    expect(ks2.list().map(s => s.provider)).toContain('google')
  })
  it('never writes plaintext to disk', () => {
    const ks = new JsonFileKeyStore(file, MASTER)
    ks.set('anthropic', 'sk-ant-PLAINTEXT')
    const raw = require('node:fs').readFileSync(file, 'utf8')
    expect(raw).not.toContain('sk-ant-PLAINTEXT')
  })
  it('get() returns undefined (NEVER throws) when the master key was rotated — so boot cannot crash', () => {
    new JsonFileKeyStore(file, MASTER).set('anthropic', 'sk-ant-12345')
    const rotated = new JsonFileKeyStore(file, '1'.repeat(64)) // different master → undecryptable row
    expect(() => rotated.get('anthropic')).not.toThrow()
    expect(rotated.get('anthropic')).toBeUndefined()
  })
  it('get() returns undefined (NEVER throws) when the master key is empty/unset', () => {
    new JsonFileKeyStore(file, MASTER).set('openai', 'sk-x')
    const noMaster = new JsonFileKeyStore(file, '') // AI_KEY_ENCRYPTION_KEY unset → defaults to ''
    expect(() => noMaster.get('openai')).not.toThrow()
    expect(noMaster.get('openai')).toBeUndefined()
  })
  it('status reports NOT configured for an undecryptable row (no split-brain with /api/providers)', () => {
    new JsonFileKeyStore(file, MASTER).set('anthropic', 'sk-ant-12345')
    const rotated = new JsonFileKeyStore(file, '1'.repeat(64))
    expect(rotated.status('anthropic').configured).toBe(false)
  })
})
