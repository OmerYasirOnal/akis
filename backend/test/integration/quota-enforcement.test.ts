import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Fastify from 'fastify'
import { buildServer } from '../../src/api/server.js'
import { registerChatRoutes } from '../../src/api/chat.routes.js'
import { JsonFileKeyStore } from '../../src/keys/KeyStore.js'
import { UsageStore } from '../../src/usage/UsageStore.js'
import type { Orchestrator } from '../../src/orchestrator/Orchestrator.js'
import type { LlmProvider, ChatRequest, ChatResult } from '../../src/agent/LlmProvider.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MASTER = '0'.repeat(64)
const MONTH = 30 * 24 * 60 * 60 * 1000
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'akis-quota-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const keyStore = () => new JsonFileKeyStore(join(dir, 'keys.json'), MASTER, () => '2026-06-01T00:00:00Z')
const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie']).split(';')[0]

/** A spy provider that records every ChatRequest (so we can assert it was NEVER called on a block). */
function spyProvider() {
  const calls: ChatRequest[] = []
  const provider: LlmProvider = {
    name: 'spy', model: 'spy-model',
    async chat(req: ChatRequest): Promise<ChatResult> { calls.push(req); return { text: 'ok', usage: { inTokens: 10, outTokens: 5 } } },
  }
  return { provider, calls }
}

describe('POST /sessions — per-user quota (build start)', () => {
  it('an exhausted owner ⇒ 429 {code:QuotaExceeded,resetAt} BEFORE orch.start (spy.notCalled)', async () => {
    const usage = new UsageStore({ periodMs: MONTH })
    // A spy orchestrator: proves orch.start is NEVER reached when the owner is over budget.
    const startSpy = vi.fn(async () => ({ id: 's1', status: 'building', idea: 'x', version: 1 }))
    const orchestrator = { start: startSpy } as unknown as Orchestrator
    const app = buildServer({ keyStore: keyStore(), usage, orchestrator, env: { AUTH_JWT_SECRET: 'q-secret', AKIS_USER_TOKEN_BUDGET: '100' } })
    const cookie = cookieOf(await app.inject({ method: 'POST', url: '/auth/signup', payload: { name: 'Ada', email: 'ada@akis.dev', password: 'password1234' } }))
    const ownerId = (await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })).json().user.id as string
    await usage.add(ownerId, 200) // over the 100-token budget

    const res = await app.inject({ method: 'POST', url: '/sessions', payload: { idea: 'a todo app' }, headers: { cookie } })
    expect(res.statusCode).toBe(429)
    expect(res.json()).toMatchObject({ code: 'QuotaExceeded' })
    expect(typeof res.json().resetAt).toBe('string')
    expect(startSpy).not.toHaveBeenCalled() // the orchestrator was never reached
  })

  it('under budget ⇒ 201 (passes through to orch.start)', async () => {
    const usage = new UsageStore({ periodMs: MONTH })
    const app = buildServer({ keyStore: keyStore(), usage, env: { AUTH_JWT_SECRET: 'q-secret', AKIS_USER_TOKEN_BUDGET: '100000' } })
    const cookie = cookieOf(await app.inject({ method: 'POST', url: '/auth/signup', payload: { name: 'Bo', email: 'bo@akis.dev', password: 'password1234' } }))
    const res = await app.inject({ method: 'POST', url: '/sessions', payload: { idea: 'a todo app' }, headers: { cookie } })
    expect(res.statusCode).toBe(201)
  })

  it('budget unset (0) ⇒ unlimited: byte-identical 201 (default dev path unchanged)', async () => {
    const app = buildServer({ keyStore: keyStore(), env: { AUTH_JWT_SECRET: 'q-secret' } }) // no budget
    const res = await app.inject({ method: 'POST', url: '/sessions', payload: { idea: 'anon app' } })
    expect(res.statusCode).toBe(201)
  })

  it('an in-flight run is NEVER interrupted: enforcement is start-only', async () => {
    // Start a build UNDER budget (201). Then drive the OWNER over budget and re-drive the SAME
    // session — the action routes (approve/run/cancel) NEVER consult the quota, so the running
    // session is reachable. A NEW build would 429, but the existing one is untouched.
    const usage = new UsageStore({ periodMs: MONTH })
    const app = buildServer({ keyStore: keyStore(), usage, env: { AUTH_JWT_SECRET: 'q-secret', AKIS_USER_TOKEN_BUDGET: '100' } })
    const cookie = cookieOf(await app.inject({ method: 'POST', url: '/auth/signup', payload: { name: 'Cy', email: 'cy@akis.dev', password: 'password1234' } }))
    const ownerId = (await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })).json().user.id as string
    // First build starts under budget.
    const created = await app.inject({ method: 'POST', url: '/sessions', payload: { idea: 'first build' }, headers: { cookie } })
    expect(created.statusCode).toBe(201)
    const id = created.json().id as string
    // Now exhaust the owner.
    await usage.add(ownerId, 500)
    // Reading/driving the EXISTING session is NOT quota-gated (start-only enforcement).
    const read = await app.inject({ method: 'GET', url: `/sessions/${id}`, headers: { cookie } })
    expect(read.statusCode).toBe(200)
    // A NEW build, however, is refused.
    const second = await app.inject({ method: 'POST', url: '/sessions', payload: { idea: 'second build' }, headers: { cookie } })
    expect(second.statusCode).toBe(429)
  })
})

describe('POST /api/chat[/stream] — per-user quota (chat turn)', () => {
  /** A bare Fastify app with ONLY the chat routes + a spy provider + injected usage/quota and a
   *  fixed owner — lets us assert the provider is NEVER called on a block, and the 429 ordering. */
  function chatApp(opts: { usage: UsageStore; budget: number; ownerId?: string }) {
    const { provider, calls } = spyProvider()
    const app = Fastify({ logger: false })
    registerChatRoutes(app, {
      provider, usage: opts.usage, quota: { budget: opts.budget, periodMs: MONTH },
      ownerOf: async () => opts.ownerId,
    })
    return { app, calls }
  }

  it('POST /api/chat exhausted ⇒ 429 BEFORE provider call; under budget ⇒ 200 + accounting', async () => {
    const usage = new UsageStore({ periodMs: MONTH })
    await usage.add('ada', 200) // over the 100 budget
    const { app, calls } = chatApp({ usage, budget: 100, ownerId: 'ada' })
    const blocked = await app.inject({ method: 'POST', url: '/api/chat', payload: { message: 'hi' } })
    expect(blocked.statusCode).toBe(429)
    expect(blocked.json()).toMatchObject({ code: 'QuotaExceeded' })
    expect(calls).toHaveLength(0) // the provider was never called

    // A different owner under budget: 200, and the turn's spend (10+5) is accounted.
    const usage2 = new UsageStore({ periodMs: MONTH })
    const { app: app2, calls: calls2 } = chatApp({ usage: usage2, budget: 1000, ownerId: 'bo' })
    const ok = await app2.inject({ method: 'POST', url: '/api/chat', payload: { message: 'hi' } })
    expect(ok.statusCode).toBe(200)
    expect(calls2).toHaveLength(1)
    await Promise.resolve()
    expect((await usage2.get('bo')).periodTokens).toBe(15)
  })

  it('POST /api/chat/stream exhausted ⇒ 429 JSON BEFORE hijack (not an SSE error frame)', async () => {
    const usage = new UsageStore({ periodMs: MONTH })
    await usage.add('ada', 200)
    const { app, calls } = chatApp({ usage, budget: 100, ownerId: 'ada' })
    const res = await app.inject({ method: 'POST', url: '/api/chat/stream', payload: { message: 'hi' } })
    expect(res.statusCode).toBe(429)
    // It is a clean JSON body, NOT a text/event-stream SSE frame.
    expect(res.headers['content-type']).toMatch(/application\/json/)
    expect(res.json()).toMatchObject({ code: 'QuotaExceeded' })
    expect(calls).toHaveLength(0)
  })

  it('budget 0 (unlimited) ⇒ chat is byte-identical 200 (no store read, no block)', async () => {
    const usage = new UsageStore({ periodMs: MONTH })
    const { app, calls } = chatApp({ usage, budget: 0, ownerId: 'ada' })
    const res = await app.inject({ method: 'POST', url: '/api/chat', payload: { message: 'hi' } })
    expect(res.statusCode).toBe(200)
    expect(calls).toHaveLength(1)
  })
})
