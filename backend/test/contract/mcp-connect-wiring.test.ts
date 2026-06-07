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
  it('the connect/callback/status routes are MOUNTED + owner-scoped (401 unauthenticated, not 404)', async () => {
    const app = makeApp()
    for (const url of ['/mcp/atlassian/connect', '/mcp/atlassian/callback?code=x&state=y', '/mcp/atlassian/status']) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode, `${url} should require auth (wired), not 404`).toBe(401)
    }
    const del = await app.inject({ method: 'DELETE', url: '/mcp/atlassian' })
    expect(del.statusCode).toBe(401)
  })
})
