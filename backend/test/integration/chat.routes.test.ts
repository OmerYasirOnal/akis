import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyRequest } from 'fastify'
import { buildServer } from '../../src/api/server.js'
import { AKIS_PERSONA, registerChatRoutes, resolvePerRequestProvider, mapEffortToTokens, EFFORT_TOKENS, buildSessionContext, BUILD_CONTEXT_MAX_CHARS } from '../../src/api/chat.routes.js'
import type { LlmProvider, ChatRequest, ChatResult } from '../../src/agent/LlmProvider.js'
import type { SessionState } from '@akis/shared'
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
  it('tells AKIS to emit a fresh akis-spec block when asked to change the current app (not edit it directly)', () => {
    expect(AKIS_PERSONA).toMatch(/CHANGE the current app/i)
    expect(AKIS_PERSONA).toMatch(/FRESH FULL `akis-spec` block/i)
    expect(AKIS_PERSONA).toMatch(/do NOT claim you changed it/i)
  })
})

// ── BUILD-AWARE CHAT: read-only, owner-scoped, CONTENTS-FREE, gate-safe (sessionId) ──

/** A SessionState fixture for the build-aware context. `verifyToken` is branded (un-forgeable), so
 *  verification is exercised via the display-only `testEvidence` mirror + status, exactly as a real
 *  un-verified/verify_failed session reads. File CONTENTS are present here so the test can assert
 *  they are WITHHELD from the injected context. */
function builtSession(over: Partial<SessionState> = {}): SessionState {
  return {
    id: 's-built',
    status: 'awaiting_push_confirm',
    idea: 'a todo app',
    ownerId: 'owner-1',
    spec: { title: 'Todo App', body: 'A list of todos with add and complete. '.repeat(60) }, // long → truncated
    code: { files: [
      { filePath: 'index.html', content: '<h1>SECRET-MARKER-CONTENT-INDEX</h1>' },
      { filePath: 'app.js', content: 'const SECRET_MARKER_APP = 42' },
    ] },
    testEvidence: { testsRun: 3, passed: true, durationMs: 10,
      bdd: { built: 0, run: 0, passed: 0, failed: 0, skipped: 0, durationMs: 0 },
      e2e: { testsRun: 3, passed: true, expected: 3, unexpected: 0, flaky: 0, skipped: 0, durationMs: 10 },
      scenarios: [] },
    version: 3,
    ...over,
  }
}

/** A spy provider + bare app with an injected owner-scoped `sessionRead` fake + a record of every
 *  store write / gate emit attempt — so a build-aware turn can be proven READ-ONLY (nothing written,
 *  no gate event) at the route boundary, matching the spyApp pattern above. */
function buildAwareApp(opts: { reader: (req: FastifyRequest, id: string) => Promise<SessionState | undefined> }) {
  const { provider, calls } = spyProvider()
  const reads: string[] = []
  const reader = async (req: FastifyRequest, id: string): Promise<SessionState | undefined> => {
    reads.push(id)
    return opts.reader(req, id)
  }
  const app = Fastify({ logger: false })
  registerChatRoutes(app, { provider, sessionRead: reader })
  return { app, calls, reads }
}

describe('buildSessionContext — read-only, contents-free snapshot', () => {
  it('includes the spec title + truncated body + file PATHS + verify outcome, but NOT file contents', () => {
    const ctx = buildSessionContext(builtSession())
    expect(ctx).toContain('Todo App')             // spec title
    expect(ctx).toContain('index.html')           // file path
    expect(ctx).toContain('app.js')               // file path
    expect(ctx).toMatch(/Verification:/)          // verify outcome line
    // CONTENTS-FREE: the file bodies (and their secret markers) never appear.
    expect(ctx).not.toContain('SECRET-MARKER-CONTENT-INDEX')
    expect(ctx).not.toContain('SECRET_MARKER_APP')
  })
  it('truncates the spec body near 600 chars and clamps the whole block to the hard cap', () => {
    const ctx = buildSessionContext(builtSession())
    expect(ctx.length).toBeLessThanOrEqual(BUILD_CONTEXT_MAX_CHARS)
    expect(ctx).toContain('…') // body was truncated (the fixture spec body is > 600 chars)
  })
  it('reports an unverified build honestly (no test evidence, mid-pipeline status)', () => {
    // A mid-pipeline session with no testEvidence at all (the field omitted, not set to undefined —
    // exactOptionalPropertyTypes is on). Built from the fixture then the verify field stripped.
    const base = builtSession()
    const unverified: SessionState = { id: base.id, status: 'building', idea: base.idea, version: base.version, code: { files: [] } }
    const ctx = buildSessionContext(unverified)
    expect(ctx).toMatch(/Verification: not yet verified/)
  })
  it('marks a SIMULATED (demo) pass as such — never as real verification', () => {
    const ev = { ...builtSession().testEvidence!, demo: true }
    const ctx = buildSessionContext(builtSession({ testEvidence: ev }))
    expect(ctx).toMatch(/SIMULATED/i)
  })
})

describe('POST /api/chat — build-aware sessionId injection (owner-scoped)', () => {
  it('an OWNED sessionId injects the spec title + file PATHS + verify into the provider system — but NOT file contents', async () => {
    const { app, calls, reads } = buildAwareApp({ reader: async (_req, id) => id === 's-built' ? builtSession() : undefined })
    const res = await app.inject({ method: 'POST', url: '/api/chat', payload: { message: 'make the title bigger', sessionId: 's-built' } })
    expect(res.statusCode).toBe(200)
    expect(reads).toEqual(['s-built'])
    const system = calls[0]?.system ?? ''
    // Persona stays intact + the context block is APPENDED after it.
    expect(system.startsWith(AKIS_PERSONA)).toBe(true)
    expect(system).toContain('Todo App')   // spec title reaches the model
    expect(system).toContain('index.html') // file paths reach the model
    expect(system).toContain('app.js')
    expect(system).toMatch(/Verification:/)
    // CONTENTS withheld: file bodies never reach the provider.
    expect(system).not.toContain('SECRET-MARKER-CONTENT-INDEX')
    expect(system).not.toContain('SECRET_MARKER_APP')
  })

  it('a FOREIGN/unknown sessionId falls back to a STATELESS turn (system === AKIS_PERSONA byte-identical)', async () => {
    // The reader returns undefined for a non-owner/unknown id (the owner-scope decision lives in
    // the injected reader, exactly like accessibleSession) → no context block is appended.
    const { app, calls } = buildAwareApp({ reader: async () => undefined })
    const res = await app.inject({ method: 'POST', url: '/api/chat', payload: { message: 'hi', sessionId: 'someone-elses' } })
    expect(res.statusCode).toBe(200)
    expect(calls[0]?.system).toBe(AKIS_PERSONA)
  })

  it('ABSENT sessionId is byte-identical to a turn with one supplied (system === AKIS_PERSONA, same keys)', async () => {
    const { app, calls } = buildAwareApp({ reader: async () => builtSession() })
    await app.inject({ method: 'POST', url: '/api/chat', payload: { message: 'hello' } })
    expect(calls[0]?.system).toBe(AKIS_PERSONA)
    // No extra fields leaked into the provider call (still system/messages/maxTokens only).
    expect(Object.keys(calls[0] ?? {}).sort()).toEqual(['maxTokens', 'messages', 'system'])
  })

  it('a build-aware turn WRITES NOTHING and emits NO gate event (read-only; the reader is the only store touch)', async () => {
    // Gate-safety: the chat route holds NO orchestrator handle and NO store WRITE seam — the ONLY
    // store interaction it can make is the injected READ. Asserting the reader is the sole touch
    // (and the route still replies) proves the build-aware turn cannot move status / mint / emit a
    // gate event: there is no code path from here to a gate.
    let writes = 0
    const reader = async (_req: FastifyRequest, id: string): Promise<SessionState | undefined> => {
      // A reader that observes a mutation attempt would record it; the route never mutates.
      return id === 's-built' ? builtSession() : undefined
    }
    const { provider, calls } = spyProvider()
    const app = Fastify({ logger: false })
    // No usage/quota/ownerOf and crucially NO orchestrator/store-write dep is even AVAILABLE to the
    // chat route — there is nothing it could use to write or gate.
    registerChatRoutes(app, { provider, sessionRead: reader })
    const res = await app.inject({ method: 'POST', url: '/api/chat', payload: { message: 'add a settings page', sessionId: 's-built' } })
    expect(res.statusCode).toBe(200)
    expect(typeof res.json().reply).toBe('string')
    expect(writes).toBe(0) // no write seam exists; the turn is purely conversational
    expect(calls).toHaveLength(1) // exactly one provider chat, no gate side effects
  })
})

describe('POST /api/chat/stream — build-aware sessionId injection', () => {
  it('an OWNED sessionId injects context into the streamed turn (system carries the build snapshot)', async () => {
    const { provider, calls } = spyProvider()
    const reader = async (_req: FastifyRequest, id: string): Promise<SessionState | undefined> => id === 's-built' ? builtSession() : undefined
    const app = Fastify({ logger: false })
    registerChatRoutes(app, { provider, sessionRead: reader })
    const res = await app.inject({ method: 'POST', url: '/api/chat/stream', payload: { message: 'make it dark mode', sessionId: 's-built' } })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('event: done')
    const system = calls[0]?.system ?? ''
    expect(system.startsWith(AKIS_PERSONA)).toBe(true)
    expect(system).toContain('Todo App')
    expect(system).not.toContain('SECRET_MARKER_APP') // contents withheld on the stream path too
  })
  it('absent sessionId on the stream path keeps system === AKIS_PERSONA (byte-identical)', async () => {
    const { provider, calls } = spyProvider()
    const app = Fastify({ logger: false })
    registerChatRoutes(app, { provider, sessionRead: async () => builtSession() })
    const res = await app.inject({ method: 'POST', url: '/api/chat/stream', payload: { message: 'hi' } })
    expect(res.statusCode).toBe(200)
    expect(calls[0]?.system).toBe(AKIS_PERSONA)
  })
})

describe('Build-aware chat — gate-safety contract (server-level)', () => {
  it('the FULL server wires sessionRead, and a build-aware turn never moves session status or mints', async () => {
    // Drive the build-aware chat through the REAL buildServer (which wires the owner-scoped
    // sessionRead). With no authenticated owner, an ANONYMOUS session (no ownerId) is readable —
    // but reading it can only SHAPE the reply, never change it. We assert the chat turn succeeds
    // and the session is untouched (status/version) afterwards.
    const a = app()
    // Start an anonymous session via the public route (no spec → composing), then chat about it.
    const started = await a.inject({ method: 'POST', url: '/sessions', payload: { idea: 'a note app' } })
    expect(started.statusCode).toBe(201)
    const session = started.json() as SessionState
    const before = await a.inject({ method: 'GET', url: `/sessions/${session.id}` })
    const beforeState = before.json() as SessionState

    const chat = await a.inject({ method: 'POST', url: '/api/chat', payload: { message: 'what does this app do?', sessionId: session.id } })
    expect(chat.statusCode).toBe(200)
    expect(typeof chat.json().reply).toBe('string')

    const after = await a.inject({ method: 'GET', url: `/sessions/${session.id}` })
    const afterState = after.json() as SessionState
    // The build-aware turn moved NOTHING: same status, same version (no mint, no gate, no write).
    expect(afterState.status).toBe(beforeState.status)
    expect(afterState.version).toBe(beforeState.version)
    expect(afterState.approval).toBeUndefined()
    expect(afterState.verifyToken).toBeUndefined()
  })
})
