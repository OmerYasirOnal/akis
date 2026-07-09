/**
 * CONTRACT: per-user ACTIVE-RUN cap (Faz 2 — multi-tenant hardening). Same SACRED pattern as
 * the token quota: a start-only, fail-closed PRE-CHECK at the route layer (429 BEFORE any
 * orchestrator/provider work). It can only REFUSE to start; it never touches a gate or an
 * in-flight run. Default (dep absent / limit 0) is byte-identical to today.
 */
import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { registerSessionRoutes } from '../../src/api/sessions.routes.js'
import { buildServices } from '../../src/di/services.js'
import { Orchestrator } from '../../src/orchestrator/Orchestrator.js'
import { MockSessionStore } from '../../src/store/MockSessionStore.js'
import { MockProvider } from '../../src/agent/providers/mock/MockProvider.js'
import { createMockTestRunner } from '../../src/verify/TestRunner.js'
import type { SessionSummary } from '../../src/store/SessionStore.js'

const skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/skills/library')

function app(opts: { user?: string; maxActiveRuns?: number; ownedStatuses?: string[] } = {}) {
  const services = buildServices({ store: new MockSessionStore(), skillsDir, provider: new MockProvider(), mockCriticScore: 90, testRunner: createMockTestRunner({ testsRun: 2, passed: true }) })
  // Deterministic active-run picture: the pre-check reads the SUMMARY projection; stub it
  // instead of racing real fire-and-forget runs through their statuses.
  if (opts.ownedStatuses) {
    services.store.listSummariesByOwner = async () => (opts.ownedStatuses ?? []).map((status, i) => ({ id: `pre${i}`, idea: 'x', status, verified: false }) as SessionSummary)
  }
  const f = Fastify({ logger: false })
  registerSessionRoutes(f, {
    orchestrator: new Orchestrator(services), services,
    userIdOf: async () => opts.user,
    ...(opts.maxActiveRuns !== undefined ? { concurrency: { maxActiveRuns: opts.maxActiveRuns } } : {}),
  })
  return f
}
const start = (f: ReturnType<typeof app>) => f.inject({ method: 'POST', url: '/sessions', payload: { idea: 'a todo app' } })

describe('CONTRACT: per-user active-run cap at POST /sessions', () => {
  it('DEFAULT (dep absent): unchanged — 201 even with active runs', async () => {
    const res = await start(app({ user: 'u1', ownedStatuses: ['building', 'building'] }))
    expect(res.statusCode).toBe(201)
  })

  it('cap 1 + one running build → 429 ConcurrencyLimited, NO session created', async () => {
    const res = await start(app({ user: 'u1', maxActiveRuns: 1, ownedStatuses: ['building'] }))
    expect(res.statusCode).toBe(429)
    expect(res.json()).toMatchObject({ code: 'ConcurrencyLimited', activeRuns: 1, limit: 1 })
  })

  it('cap 1 + nothing running → 201', async () => {
    const res = await start(app({ user: 'u1', maxActiveRuns: 1, ownedStatuses: ['done', 'push_failed', 'awaiting_spec_approval'] }))
    expect(res.statusCode).toBe(201)
  })

  it('anonymous stays exempt (governed by requireAuthForBuilds + the anon token quota)', async () => {
    const res = await start(app({ maxActiveRuns: 1, ownedStatuses: ['building'] }))
    expect(res.statusCode).toBe(201)
  })
})

describe('CONTRACT: the cap also guards approve (approving a parked spec STARTS compute)', () => {
  it('cap 1 + one running build → approve is refused 429 BEFORE any orchestrator action', async () => {
    const f = app({ user: 'u1', maxActiveRuns: 1, ownedStatuses: ['building'] })
    const res = await f.inject({ method: 'POST', url: '/sessions/does-not-matter/approve' })
    expect(res.statusCode).toBe(429)
    expect(res.json().code).toBe('ConcurrencyLimited')
  })

  it('dep absent: approve behavior unchanged (unknown id → 404, not 429)', async () => {
    const f = app({ user: 'u1', ownedStatuses: ['building'] })
    const res = await f.inject({ method: 'POST', url: '/sessions/nope/approve' })
    expect(res.statusCode).toBe(404)
  })
})
