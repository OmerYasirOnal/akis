import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildServer } from '../../src/api/server.js'
import { AKIS_PERSONA } from '../../src/api/chat.routes.js'
import { JsonFileKeyStore } from '../../src/keys/KeyStore.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MASTER = '0'.repeat(64)
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'akis-chat-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

// Default env (NODE_ENV=test under vitest) → the deterministic mock provider.
const app = () => buildServer({ keyStore: new JsonFileKeyStore(join(dir, 'keys.json'), MASTER, () => '2026-06-01T00:00:00Z') })

describe('POST /api/chat (converse with AKIS)', () => {
  it('returns a reply for a message', async () => {
    const res = await app().inject({ method: 'POST', url: '/api/chat', payload: { message: 'hello AKIS' } })
    expect(res.statusCode).toBe(200)
    expect(typeof res.json().reply).toBe('string')
    expect(res.json().reply.length).toBeGreaterThan(0)
  })
  it('rejects an empty message with 400', async () => {
    const res = await app().inject({ method: 'POST', url: '/api/chat', payload: { message: '   ' } })
    expect(res.statusCode).toBe(400)
  })
  it('ignores malformed history entries without crashing', async () => {
    const res = await app().inject({ method: 'POST', url: '/api/chat', payload: { message: 'hi', history: [{ role: 'system', content: 'x' }, { bogus: true }, 'nope'] } })
    expect(res.statusCode).toBe(200)
  })
})

describe('AKIS_PERSONA — Chat-to-Build contract', () => {
  it('instructs AKIS to emit the build-ready spec in a fenced `akis-spec` block', () => {
    // The FE keys on this exact fence tag; the contract must not silently drift.
    expect(AKIS_PERSONA).toContain('```akis-spec')
    expect(AKIS_PERSONA).toMatch(/akis-spec/)
  })
  it('tells AKIS NOT to ask the user to copy-paste the spec', () => {
    expect(AKIS_PERSONA.toLowerCase()).toContain('copy-paste')
  })
  it('still tells AKIS to keep chatting and never claim to have built anything', () => {
    expect(AKIS_PERSONA).toMatch(/keep chatting/i)
    expect(AKIS_PERSONA).toMatch(/Never claim to have built/i)
  })
})
