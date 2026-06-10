import { describe, it, expect, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { buildServer } from '../../src/api/server.js'
import { buildServices } from '../../src/di/services.js'
import { Orchestrator } from '../../src/orchestrator/Orchestrator.js'
import { MockSessionStore } from '../../src/store/MockSessionStore.js'
import { MockProvider } from '../../src/agent/providers/mock/MockProvider.js'
import { createMockTestRunner } from '../../src/verify/TestRunner.js'
import type { KeyStore } from '../../src/keys/KeyStore.js'

const skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/skills/library')
const noKeyStore: KeyStore = { status: (p: string) => ({ provider: p, configured: false }), get: () => undefined, set: () => {}, remove: () => {}, list: () => [] }

function makeApp(opts: { passing?: boolean } = {}) {
  const services = buildServices({
    store: new MockSessionStore(),
    skillsDir,
    provider: new MockProvider(),
    testRunner: createMockTestRunner({ testsRun: 2, passed: opts.passing ?? true }),
  })
  const orchestrator = new Orchestrator(services)
  return { app: buildServer({ keyStore: noKeyStore, services, orchestrator }), services }
}

describe('CONTRACT: orchestrator HTTP routes (CF1)', () => {
  it('POST /sessions creates a session (201 with id)', async () => {
    const { app } = makeApp()
    const res = await app.inject({ method: 'POST', url: '/sessions', payload: { idea: 'todo app' } })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(typeof body.id).toBe('string')
    expect(body.status).toBeDefined()
  })

  it('POST /sessions with empty idea -> 400', async () => {
    const { app } = makeApp()
    const res = await app.inject({ method: 'POST', url: '/sessions', payload: { idea: '  ' } })
    expect(res.statusCode).toBe(400)
  })

  it('GET /sessions/:id returns state; unknown -> 404', async () => {
    const { app } = makeApp()
    const created = (await app.inject({ method: 'POST', url: '/sessions', payload: { idea: 'todo' } })).json()
    const ok = await app.inject({ method: 'GET', url: `/sessions/${created.id}` })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().id).toBe(created.id)
    const miss = await app.inject({ method: 'GET', url: '/sessions/nope' })
    expect(miss.statusCode).toBe(404)
  })

  it('happy path: start -> approve -> run -> confirm reaches done', async () => {
    const { app } = makeApp({ passing: true })
    const s = (await app.inject({ method: 'POST', url: '/sessions', payload: { idea: 'todo' } })).json()
    expect((await app.inject({ method: 'POST', url: `/sessions/${s.id}/approve` })).statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: `/sessions/${s.id}/run` })).statusCode).toBe(200)
    const done = await app.inject({ method: 'POST', url: `/sessions/${s.id}/confirm` })
    expect(done.statusCode).toBe(200)
    expect(done.json().status).toBe('done')
  })

  it('P0-1: a spec-seeded POST /sessions opens already spec-approved (building) and runs to done with NO /approve AND NO /run call', async () => {
    const { app } = makeApp({ passing: true })
    const seed = { title: 'Todo', body: '# Todo\nThe app.' }
    const created = (await app.inject({ method: 'POST', url: '/sessions', payload: { idea: seed.body, spec: seed } })).json()
    // The chat-approved seed satisfied Gate 1 server-side: the session is ALREADY building.
    expect(created.status).toBe('building')
    // No /approve AND no /run — the chat SpecCard click is the SINGLE human action; the server
    // kicks the pipeline itself (caught LIVE: relying on the FE's legacy /run caller wedged
    // every seeded build at 'building' forever). Poll until the auto-run parks at the push gate.
    await vi.waitFor(async () => {
      const cur = (await app.inject({ method: 'GET', url: `/sessions/${created.id}` })).json()
      expect(cur.status).toBe('awaiting_push_confirm')
    })
    const done = await app.inject({ method: 'POST', url: `/sessions/${created.id}/confirm` })
    expect(done.statusCode).toBe(200)
    expect(done.json().status).toBe('done')
  })

  it('startSession seeds session.chat from the client pre-build conversation (bounded, round-trips through GET)', async () => {
    // The pre-build, sessionId-less conversation that SHAPED the spec is sent at build start so a
    // reopen (same OR cross device) also rehydrates it. Seeded ATOMICALLY into the creation state
    // (a NON-gate column, NOT a post-start patch), each turn stamped with a SERVER-set ISO `at`; it
    // round-trips through GET /sessions/:id. The 201 already reflects it (no re-read).
    const { app } = makeApp()
    const res = await app.inject({ method: 'POST', url: '/sessions', payload: { idea: 'note app', chat: [{ role: 'user', content: 'a note app' }] } })
    expect(res.statusCode).toBe(201)
    const created = res.json()
    expect(created.chat).toEqual([{ role: 'user', content: 'a note app', at: expect.any(String) }])
    const { id } = created
    const s = (await app.inject({ method: 'GET', url: `/sessions/${id}` })).json()
    expect(s.chat).toEqual([{ role: 'user', content: 'a note app', at: expect.any(String) }])
  })

  it('startSession drops empty/invalid chat turns, server-sets the timestamp, and caps to CHAT_TURNS_MAX', async () => {
    const { app } = makeApp()
    // 1 valid + 1 empty (dropped) + 1 malformed role (dropped); a client-supplied `at` is IGNORED
    // (server-set). CHAT_TURNS_MAX is 200, well above this list.
    const chat = [
      { role: 'user', content: 'keep me', at: 'CLIENT-FORGED' },
      { role: 'assistant', content: '   ' },
      { role: 'bogus', content: 'drop me' },
    ]
    const res = await app.inject({ method: 'POST', url: '/sessions', payload: { idea: 'note app', chat } })
    expect(res.statusCode).toBe(201)
    const { id } = res.json()
    const s = (await app.inject({ method: 'GET', url: `/sessions/${id}` })).json()
    expect(s.chat).toHaveLength(1)
    expect(s.chat[0]).toMatchObject({ role: 'user', content: 'keep me' })
    expect(s.chat[0].at).not.toBe('CLIENT-FORGED') // the timestamp is server-set, never trusted from the client
  })

  it('REGRESSION (race fix): a spec-seeded POST /sessions WITH chat runs to the push gate (NOT failed) and the chat is present in the created session immediately', async () => {
    // BUG: a post-start store.update(id,{chat},version) would run CONCURRENTLY with the fire-and-
    // forget build pipeline; landing between the pipeline's version read and its {code} write, it
    // bumped the version → a `version conflict` → the build went `failed` with no code (but chat +
    // approval present). The fix threads the validated chat INTO orch.start, baking it into the
    // creation state (version 0) — one write, no race.
    const { app } = makeApp({ passing: true })
    const seed = { title: 'Todo', body: '# Todo\nThe app.' }
    const created = (await app.inject({
      method: 'POST', url: '/sessions',
      payload: { idea: seed.body, spec: seed, chat: [{ role: 'user', content: 'a todo app' }] },
    })).json()
    // The 201 already reflects the seeded chat (set at creation, NOT a post-start re-read).
    expect(created.status).toBe('building')
    expect(created.chat).toEqual([{ role: 'user', content: 'a todo app', at: expect.any(String) }])
    // The auto-kicked build reaches the push gate — it is NOT raced to `failed` by a chat write.
    await vi.waitFor(async () => {
      const cur = (await app.inject({ method: 'GET', url: `/sessions/${created.id}` })).json()
      expect(cur.status).toBe('awaiting_push_confirm')
    })
    const cur = (await app.inject({ method: 'GET', url: `/sessions/${created.id}` })).json()
    expect(cur.status).not.toBe('failed')
    expect(cur.chat).toEqual([{ role: 'user', content: 'a todo app', at: expect.any(String) }])
  })

  it('P0-1: a malformed spec seed (missing body) -> 400 (a build never proceeds on a half spec)', async () => {
    const { app } = makeApp()
    const res = await app.inject({ method: 'POST', url: '/sessions', payload: { idea: 'todo', spec: { title: 'Only a title' } } })
    expect(res.statusCode).toBe(400)
  })

  it('Gate 1 NOT bypassable via HTTP: run before approve -> 409', async () => {
    const { app } = makeApp()
    const s = (await app.inject({ method: 'POST', url: '/sessions', payload: { idea: 'todo' } })).json()
    const res = await app.inject({ method: 'POST', url: `/sessions/${s.id}/run` })
    expect(res.statusCode).toBe(409)
  })

  it('Gate 4 NOT bypassable via HTTP: confirm before verify -> 409', async () => {
    const { app } = makeApp({ passing: false }) // verifier fails closed
    const s = (await app.inject({ method: 'POST', url: '/sessions', payload: { idea: 'todo' } })).json()
    await app.inject({ method: 'POST', url: `/sessions/${s.id}/approve` })
    await app.inject({ method: 'POST', url: `/sessions/${s.id}/run` }) // not verified
    const res = await app.inject({ method: 'POST', url: `/sessions/${s.id}/confirm` })
    expect(res.statusCode).toBe(409)
  })

  it('action on unknown session -> 404', async () => {
    const { app } = makeApp()
    const res = await app.inject({ method: 'POST', url: '/sessions/nope/approve' })
    expect(res.statusCode).toBe(404)
  })

  it('GET /sessions/:id/log returns the retained {seq,event}[] + head (re-sync after reset)', async () => {
    const { app, services } = makeApp()
    const s = (await app.inject({ method: 'POST', url: '/sessions', payload: { idea: 'todo' } })).json()
    const res = await app.inject({ method: 'GET', url: `/sessions/${s.id}/log` })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.head).toBe(services.bus.head(s.id))
    expect(Array.isArray(body.events)).toBe(true)
    expect(body.events[0]).toHaveProperty('seq')
    expect(body.events[0]).toHaveProperty('event')
    expect(body.events.map((e: { seq: number }) => e.seq)).toEqual(body.events.map((_: unknown, i: number) => i + 1))
    expect((await app.inject({ method: 'GET', url: '/sessions/nope/log' })).statusCode).toBe(404)
  })
})
