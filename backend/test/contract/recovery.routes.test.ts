/**
 * CONTRACT: the recovery HTTP endpoints (run-state recovery) — owner-scoped, like the
 * other gate routes, and they NEVER bypass a structural gate.
 *   POST /sessions/:id/resolve  { decision: 'proceed' | 'abandon' }  (critic-resolution)
 *   POST /sessions/:id/retry                                          (verify-fail retry)
 */
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

function makeApp(opts: { mockCriticScore?: number; testsRun?: number; passed?: boolean } = {}) {
  const services = buildServices({
    store: new MockSessionStore(), skillsDir, provider: new MockProvider(),
    mockCriticScore: opts.mockCriticScore ?? 90,
    testRunner: createMockTestRunner({ testsRun: opts.testsRun ?? 2, passed: opts.passed ?? true }),
  })
  return { app: buildServer({ keyStore: noKeyStore, services, orchestrator: new Orchestrator(services) }), services }
}

describe('CONTRACT: recovery routes', () => {
  it('POST /sessions/:id/resolve {abandon} from awaiting_critic_resolution → 200 cancelled', async () => {
    const { app } = makeApp({ mockCriticScore: 65 }) // spec rejected → parks at critic_resolution
    const s = (await app.inject({ method: 'POST', url: '/sessions', payload: { idea: 'todo' } })).json()
    expect(s.status).toBe('awaiting_critic_resolution')
    const res = await app.inject({ method: 'POST', url: `/sessions/${s.id}/resolve`, payload: { decision: 'abandon' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('cancelled')
  })

  it('POST /sessions/:id/resolve {proceed} from a SPEC-step park opens the spec gate (Gate 1 intact)', async () => {
    const { app } = makeApp({ mockCriticScore: 65 })
    const s = (await app.inject({ method: 'POST', url: '/sessions', payload: { idea: 'todo' } })).json()
    const res = await app.inject({ method: 'POST', url: `/sessions/${s.id}/resolve`, payload: { decision: 'proceed' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('awaiting_spec_approval') // structural spec gate, not auto-build
  })

  it('POST /sessions/:id/resolve with a bad decision → 400', async () => {
    const { app } = makeApp({ mockCriticScore: 65 })
    const s = (await app.inject({ method: 'POST', url: '/sessions', payload: { idea: 'todo' } })).json()
    const res = await app.inject({ method: 'POST', url: `/sessions/${s.id}/resolve`, payload: { decision: 'nope' } })
    expect(res.statusCode).toBe(400)
  })

  it('POST /sessions/:id/resolve from the wrong status → 409', async () => {
    const { app } = makeApp() // good spec → awaiting_spec_approval, not critic_resolution
    const s = (await app.inject({ method: 'POST', url: '/sessions', payload: { idea: 'todo' } })).json()
    const res = await app.inject({ method: 'POST', url: `/sessions/${s.id}/resolve`, payload: { decision: 'proceed' } })
    expect(res.statusCode).toBe(409)
  })

  it('POST /sessions/:id/retry re-runs real verification; fail-closed verifier stays verify_failed (409 on push)', async () => {
    const { app } = makeApp({ testsRun: 0, passed: true }) // verifier mints no token
    const s = (await app.inject({ method: 'POST', url: '/sessions', payload: { idea: 'todo' } })).json()
    await app.inject({ method: 'POST', url: `/sessions/${s.id}/approve` })
    await app.inject({ method: 'POST', url: `/sessions/${s.id}/run` }) // → verify_failed
    const retry = await app.inject({ method: 'POST', url: `/sessions/${s.id}/retry` })
    expect(retry.statusCode).toBe(200)
    expect(retry.json().status).toBe('verify_failed') // still no real pass — Gate 3 intact
    // Push remains impossible (Gate 4): no verify token.
    expect((await app.inject({ method: 'POST', url: `/sessions/${s.id}/confirm` })).statusCode).toBe(409)
  })

  it('POST /sessions/:id/retry from the wrong status → 409', async () => {
    const { app } = makeApp()
    const s = (await app.inject({ method: 'POST', url: '/sessions', payload: { idea: 'todo' } })).json()
    const res = await app.inject({ method: 'POST', url: `/sessions/${s.id}/retry` }) // awaiting_spec_approval
    expect(res.statusCode).toBe(409)
  })

  it('recovery actions on an unknown session → 404', async () => {
    const { app } = makeApp()
    expect((await app.inject({ method: 'POST', url: '/sessions/nope/resolve', payload: { decision: 'proceed' } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: '/sessions/nope/retry' })).statusCode).toBe(404)
  })

  // ── Run control: POST /sessions/:id/cancel — owner-scoped, version-safe, terminal abandon. ──
  it('POST /sessions/:id/cancel from an in-flight run → 200 cancelled (not a gate bypass)', async () => {
    const { app } = makeApp() // good spec → awaiting_spec_approval (in-flight)
    const s = (await app.inject({ method: 'POST', url: '/sessions', payload: { idea: 'todo' } })).json()
    const res = await app.inject({ method: 'POST', url: `/sessions/${s.id}/cancel` })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('cancelled')
    expect(res.json().verifyToken).toBeUndefined() // never verified/shipped
  })

  it('POST /sessions/:id/cancel from a terminal run → 409', async () => {
    const { app } = makeApp()
    const s = (await app.inject({ method: 'POST', url: '/sessions', payload: { idea: 'todo' } })).json()
    await app.inject({ method: 'POST', url: `/sessions/${s.id}/approve` })
    await app.inject({ method: 'POST', url: `/sessions/${s.id}/run` })
    await app.inject({ method: 'POST', url: `/sessions/${s.id}/confirm` }) // → done (terminal)
    const res = await app.inject({ method: 'POST', url: `/sessions/${s.id}/cancel` })
    expect(res.statusCode).toBe(409)
  })

  it('POST /sessions/:id/cancel on an unknown session → 404', async () => {
    const { app } = makeApp()
    expect((await app.inject({ method: 'POST', url: '/sessions/nope/cancel' })).statusCode).toBe(404)
  })
})
