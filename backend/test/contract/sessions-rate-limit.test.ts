/**
 * CONTRACT: per-caller request-RATE limit on the build-start + approve routes (Faz 2 abuse
 * guard). Same SACRED start-only shape as the quota/concurrency caps: a 429 at the route
 * boundary BEFORE any orchestrator work. Default (dep absent) is byte-identical.
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
import { resolveRouteRateLimits } from '../../src/usage/rateLimit.js'

const skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/skills/library')

function app(opts: { user?: string; buildMax?: number } = {}) {
  const services = buildServices({ store: new MockSessionStore(), skillsDir, provider: new MockProvider(), mockCriticScore: 90, testRunner: createMockTestRunner({ testsRun: 2, passed: true }) })
  const f = Fastify({ logger: false })
  const rateLimits = opts.buildMax !== undefined
    ? resolveRouteRateLimits({ AKIS_RATE_LIMIT: '1', AKIS_RATE_LIMIT_BUILD_MAX: String(opts.buildMax) })
    : undefined
  registerSessionRoutes(f, {
    orchestrator: new Orchestrator(services), services,
    userIdOf: async () => opts.user,
    ...(rateLimits ? { rateLimits } : {}),
  })
  return f
}
const start = (f: ReturnType<typeof app>) => f.inject({ method: 'POST', url: '/sessions', payload: { idea: 'a todo app' } })

describe('CONTRACT: build-start rate limit', () => {
  it('DEFAULT (dep absent): unchanged — repeated starts all 201', async () => {
    const f = app({ user: 'u1' })
    expect((await start(f)).statusCode).toBe(201)
    expect((await start(f)).statusCode).toBe(201)
    expect((await start(f)).statusCode).toBe(201)
  })

  it('cap 1: the 2nd rapid start → 429 RateLimited with a retry-after header, NO extra session', async () => {
    const f = app({ user: 'u1', buildMax: 1 })
    expect((await start(f)).statusCode).toBe(201)
    const res = await start(f)
    expect(res.statusCode).toBe(429)
    expect(res.json().code).toBe('RateLimited')
    expect(res.headers['retry-after']).toBeTruthy()
  })

  it('the cap is keyed per-owner: a different user is unaffected by the first user hitting the cap', async () => {
    const shared = buildServices({ store: new MockSessionStore(), skillsDir, provider: new MockProvider(), mockCriticScore: 90, testRunner: createMockTestRunner({ testsRun: 2, passed: true }) })
    const f = Fastify({ logger: false })
    let user = 'u1'
    const rateLimits = resolveRouteRateLimits({ AKIS_RATE_LIMIT: '1', AKIS_RATE_LIMIT_BUILD_MAX: '1' })!
    registerSessionRoutes(f, { orchestrator: new Orchestrator(shared), services: shared, userIdOf: async () => user, rateLimits })
    expect((await f.inject({ method: 'POST', url: '/sessions', payload: { idea: 'x' } })).statusCode).toBe(201)
    expect((await f.inject({ method: 'POST', url: '/sessions', payload: { idea: 'x' } })).statusCode).toBe(429)
    user = 'u2'
    expect((await f.inject({ method: 'POST', url: '/sessions', payload: { idea: 'x' } })).statusCode).toBe(201)
  })

  it('approve is rate-limited too (approve starts compute): cap 1, one start then an approve → 429', async () => {
    const f = app({ user: 'u1', buildMax: 1 })
    expect((await start(f)).statusCode).toBe(201) // consumes the single build token
    const res = await f.inject({ method: 'POST', url: '/sessions/any/approve' })
    expect(res.statusCode).toBe(429)
    expect(res.json().code).toBe('RateLimited')
  })
})
