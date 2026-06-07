/**
 * CONTRACT: the opt-in "require auth to start a build" policy (audit #29). Default OFF keeps the
 * keyless-demo (anonymous builds allowed); ON refuses an anonymous (public-by-UUID) build so every
 * session is owned. Owner-scoping of EXISTING sessions is unchanged either way.
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

const skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/skills/library')

function app(opts: { user?: string; requireAuthForBuilds?: boolean } = {}) {
  const services = buildServices({ store: new MockSessionStore(), skillsDir, provider: new MockProvider(), mockCriticScore: 90, testRunner: createMockTestRunner({ testsRun: 2, passed: true }) })
  const f = Fastify({ logger: false })
  registerSessionRoutes(f, {
    orchestrator: new Orchestrator(services), services,
    userIdOf: async () => opts.user,
    ...(opts.requireAuthForBuilds ? { requireAuthForBuilds: true } : {}),
  })
  return f
}
const start = (f: ReturnType<typeof app>) => f.inject({ method: 'POST', url: '/sessions', payload: { idea: 'a todo app' } })

describe('CONTRACT: requireAuthForBuilds (anonymous-session scope, audit #29)', () => {
  it('DEFAULT (off): an anonymous build is allowed → 201 (keyless-demo + existing behavior)', async () => {
    const res = await start(app({})) // no user, flag off
    expect(res.statusCode).toBe(201)
    expect(res.json().ownerId).toBeUndefined()
  })

  it('flag ON + unauthenticated → 401, NO session created', async () => {
    const res = await start(app({ requireAuthForBuilds: true }))
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('Unauthorized')
  })

  it('flag ON + authenticated → 201, the build is OWNED', async () => {
    const res = await start(app({ requireAuthForBuilds: true, user: 'owner1' }))
    expect(res.statusCode).toBe(201)
    expect(res.json().ownerId).toBe('owner1')
  })
})
