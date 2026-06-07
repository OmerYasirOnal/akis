/**
 * CONTRACT: buildServer REGISTERS the remote-MCP connect routes (server.ts wiring). The route logic
 * is unit-tested in mcp-connect.routes.test.ts; this pins that the routes are actually mounted on the
 * real server + owner-scoped (requireAuth fires) — a 401 for an unauthenticated request proves the
 * route exists (a 404 would mean it was never wired).
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

function makeApp() {
  const services = buildServices({ store: new MockSessionStore(), skillsDir, provider: new MockProvider(), mockCriticScore: 90, testRunner: createMockTestRunner({ testsRun: 2, passed: true }) })
  return buildServer({ keyStore: noKeyStore, services, orchestrator: new Orchestrator(services) })
}

describe('CONTRACT: remote-MCP connect routes are wired into buildServer', () => {
  it('the connect/status/disconnect routes are MOUNTED + owner-scoped (401 unauthenticated, not 404)', async () => {
    const app = makeApp()
    // connect + status are same-site → the session cookie is the right gate → 401 unauthenticated.
    for (const url of ['/mcp/atlassian/connect', '/mcp/atlassian/status']) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode, `${url} should require auth (wired), not 404`).toBe(401)
    }
    const del = await app.inject({ method: 'DELETE', url: '/mcp/atlassian' })
    expect(del.statusCode).toBe(401)
  })

  it('the callback is MOUNTED + state-gated, NOT cookie-gated (works under SameSite=Strict; audit #2)', async () => {
    // The OAuth return is a cross-site top-level GET; under SameSite=Strict the cookie is dropped, so
    // the callback must NOT 401 on a missing cookie — identity comes from the signed state. An
    // unauthenticated callback with a bogus state is REDIRECTED (?mcp=denied), proving it is wired
    // (not 404) and gated on the state (not the cookie).
    const app = makeApp()
    const res = await app.inject({ method: 'GET', url: '/mcp/atlassian/callback?code=x&state=y' })
    expect(res.statusCode, 'callback should be wired (a redirect), not 404/401').toBe(302)
    expect(res.headers.location).toMatch(/mcp=denied/)
  })
})
