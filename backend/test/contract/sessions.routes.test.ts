import { describe, it, expect } from 'vitest'
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
})
