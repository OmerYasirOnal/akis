import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'
import { buildServer } from '../../src/api/server.js'
import { AKIS_PERSONA, registerChatRoutes, resolvePerRequestProvider, mapEffortToTokens, EFFORT_TOKENS } from '../../src/api/chat.routes.js'
import type { LlmProvider, ChatRequest, ChatResult } from '../../src/agent/LlmProvider.js'
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

// ── Model picker: per-request {provider, model, effort} (CHAT-ONLY) ──

/** A spy provider that records the ChatRequest it was handed (to assert maxTokens / parity). */
function spyProvider() {
  const calls: ChatRequest[] = []
  const provider: LlmProvider = {
    name: 'spy',
    model: 'spy-model',
    async chat(req: ChatRequest): Promise<ChatResult> { calls.push(req); return { text: 'ok' } },
  }
  return { provider, calls }
}

/** A bare Fastify app with ONLY the chat routes + a spy provider — lets us inspect the exact
 *  ChatRequest (maxTokens, byte-identical parity) without the full server stack. NODE_ENV=test
 *  here means a NAMED provider override still resolves the mock, so these tests focus on the
 *  request shape; CATALOG validation + NoKey are covered against the full server below. */
function spyApp() {
  const { provider, calls } = spyProvider()
  const app = Fastify({ logger: false })
  registerChatRoutes(app, { provider })
  return { app, calls }
}

describe('mapEffortToTokens — effort → maxTokens', () => {
  it('maps fast → 2048', () => { expect(mapEffortToTokens('fast')).toBe(2048); expect(EFFORT_TOKENS.fast).toBe(2048) })
  it('maps balanced → 8192', () => { expect(mapEffortToTokens('balanced')).toBe(8192); expect(EFFORT_TOKENS.balanced).toBe(8192) })
  it('maps deep → 16384', () => { expect(mapEffortToTokens('deep')).toBe(16384); expect(EFFORT_TOKENS.deep).toBe(16384) })
  it('defaults absent effort → 8192 (balanced)', () => { expect(mapEffortToTokens(undefined)).toBe(8192) })
  it('defaults an invalid/misspelled effort → 8192 (balanced), never throws', () => {
    expect(mapEffortToTokens('typo')).toBe(8192)
    expect(mapEffortToTokens('FAST')).toBe(2048) // case-insensitive
  })
})

describe('POST /api/chat — per-request effort → maxTokens', () => {
  it('effort "fast" sends maxTokens 2048', async () => {
    const { app, calls } = spyApp()
    const res = await app.inject({ method: 'POST', url: '/api/chat', payload: { message: 'hi', effort: 'fast' } })
    expect(res.statusCode).toBe(200)
    expect(calls[0]?.maxTokens).toBe(2048)
  })
  it('effort "deep" sends maxTokens 16384', async () => {
    const { app, calls } = spyApp()
    await app.inject({ method: 'POST', url: '/api/chat', payload: { message: 'hi', effort: 'deep' } })
    expect(calls[0]?.maxTokens).toBe(16384)
  })
  it('absent effort sends maxTokens 8192 (balanced default)', async () => {
    const { app, calls } = spyApp()
    await app.inject({ method: 'POST', url: '/api/chat', payload: { message: 'hi' } })
    expect(calls[0]?.maxTokens).toBe(8192)
  })
  it('an invalid effort silently sends maxTokens 8192 (balanced), still 200', async () => {
    const { app, calls } = spyApp()
    const res = await app.inject({ method: 'POST', url: '/api/chat', payload: { message: 'hi', effort: 'turbo' } })
    expect(res.statusCode).toBe(200)
    expect(calls[0]?.maxTokens).toBe(8192)
  })
})

describe('POST /api/chat — backward compatibility (byte-identical default)', () => {
  it('omitting {provider, model, effort} produces the SAME ChatRequest as null fields', async () => {
    const { app, calls } = spyApp()
    await app.inject({ method: 'POST', url: '/api/chat', payload: { message: 'hello' } })
    await app.inject({ method: 'POST', url: '/api/chat', payload: { message: 'hello', provider: null, model: null, effort: null } })
    // Both turns hit the default provider with the SAME request (no extra fields appended).
    expect(calls).toHaveLength(2)
    expect(calls[1]).toStrictEqual(calls[0])
    // The default budget is exactly the balanced (today's) budget — no drift.
    expect(calls[0]?.maxTokens).toBe(8192)
    // The ChatRequest carries ONLY the historical fields (system, messages, maxTokens) — no
    // provider/model/effort leaked into the provider call.
    expect(Object.keys(calls[0] ?? {}).sort()).toEqual(['maxTokens', 'messages', 'system'])
  })
})

describe('POST /api/chat — provider/model validation (CATALOG, 400 not 500)', () => {
  it('accepts a valid {provider, model, effort} override (200)', async () => {
    const res = await app().inject({ method: 'POST', url: '/api/chat', payload: { message: 'hi', provider: 'anthropic', model: 'claude-haiku-4-5-20251001', effort: 'fast' } })
    expect(res.statusCode).toBe(200)
    expect(typeof res.json().reply).toBe('string')
  })
  it('rejects an unknown provider with 400 BadRequest', async () => {
    const res = await app().inject({ method: 'POST', url: '/api/chat', payload: { message: 'hi', provider: 'unknown-provider', model: 'some-model' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('BadRequest')
  })
  it('rejects an unknown model for a known provider with 400 BadRequest', async () => {
    const res = await app().inject({ method: 'POST', url: '/api/chat', payload: { message: 'hi', provider: 'anthropic', model: 'unknown-model-xyz' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('BadRequest')
  })
  it('rejects a model with no provider (ambiguous) with 400 BadRequest', async () => {
    const res = await app().inject({ method: 'POST', url: '/api/chat', payload: { message: 'hi', model: 'claude-haiku-4-5-20251001' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('BadRequest')
  })
})

describe('resolvePerRequestProvider — fail-closed resolution', () => {
  const { provider: defaultProvider } = spyProvider()

  it('returns the default provider UNCHANGED when no override is given (byte-identical)', () => {
    expect(resolvePerRequestProvider(defaultProvider, undefined, undefined)).toBe(defaultProvider)
  })
  it('throws BadRequest (400) for an unknown provider', () => {
    try { resolvePerRequestProvider(defaultProvider, 'nope', undefined); throw new Error('should have thrown') }
    catch (e) { expect((e as { status?: number; code?: string }).status).toBe(400); expect((e as { code?: string }).code).toBe('BadRequest') }
  })
  it('throws BadRequest (400) for an unknown model under a known provider', () => {
    try { resolvePerRequestProvider(defaultProvider, 'anthropic', 'no-such-model'); throw new Error('should have thrown') }
    catch (e) { expect((e as { code?: string }).code).toBe('BadRequest') }
  })
  it('throws NoKey (400) — NOT 500, NEVER the key — when a real provider has no API key', () => {
    // A NON-test env so createProvider runs the REAL fail-closed path (the test mock is skipped).
    // No key in env and no KeyStore → ProviderConfigError → mapped to a clean 400 NoKey.
    try {
      resolvePerRequestProvider(defaultProvider, 'anthropic', 'claude-haiku-4-5-20251001', { NODE_ENV: 'production' })
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as { status?: number }).status).toBe(400)
      expect((e as { code?: string }).code).toBe('NoKey')
      // The message must stay generic — never echo a key value.
      expect(String((e as Error).message)).not.toMatch(/sk-/)
    }
  })
  it('resolves a REAL provider when its key IS present (no throw)', () => {
    const p = resolvePerRequestProvider(defaultProvider, 'anthropic', 'claude-haiku-4-5-20251001', { NODE_ENV: 'production', ANTHROPIC_API_KEY: 'sk-ant-test' })
    expect(p).not.toBe(defaultProvider)
    expect(p.name).toBe('anthropic')
  })
})

describe('POST /api/chat/stream — per-request overrides', () => {
  it('streams with overridden {provider, effort} (200 SSE)', async () => {
    const res = await app().inject({ method: 'POST', url: '/api/chat/stream', payload: { message: 'hi', provider: 'anthropic', effort: 'deep' } })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/event-stream')
    expect(res.body).toContain('event: done')
  })
  it('rejects an unknown provider with a clean 400 BadRequest (before hijack)', async () => {
    const res = await app().inject({ method: 'POST', url: '/api/chat/stream', payload: { message: 'hi', provider: 'nope' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('BadRequest')
  })
})

describe('AKIS_PERSONA — Chat-to-Build contract', () => {
  it('instructs AKIS to emit the build-ready spec in a fenced `akis-spec` block', () => {
    // The FE keys on this exact fence tag; the contract must not silently drift. Four
    // backticks so a spec body's own ```code blocks don't close the akis-spec fence early.
    expect(AKIS_PERSONA).toContain('````akis-spec')
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
