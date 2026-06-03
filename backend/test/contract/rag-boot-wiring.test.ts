import { describe, it, expect } from 'vitest'
import { buildServer } from '../../src/api/server.js'
import type { KeyStore } from '../../src/keys/KeyStore.js'

/**
 * Pins the BOOT-PATH RAG wiring that every other RAG test bypasses by injecting a pre-built
 * `services` (which short-circuits buildServer's internal buildServices). These are the exact
 * lines hand-merged in the B↔D lane reconciliation (server.ts: `rag: true, env` threading +
 * the vectorStore spread) — untested, so a future re-break would pass CI green. Here we boot
 * buildServer WITHOUT injecting services and assert behaviour driven purely by env.
 */
const noKeyStore: KeyStore = { status: p => ({ provider: p, configured: false }), get: () => undefined, set: () => {}, remove: () => {}, list: () => [] }

describe('CONTRACT: boot-path RAG wiring (services NOT injected)', () => {
  it('registers /sessions/:id/knowledge/repo when AKIS_RAG=1 (rag+env threaded into buildServices → repoSource built)', async () => {
    const app = buildServer({ keyStore: noKeyStore, env: { AUTH_JWT_SECRET: 's', AKIS_RAG: '1', AKIS_ALLOW_MOCK: '1', AKIS_GITHUB_TOKEN: 'x', AKIS_GITHUB_REPO: 'me/proj' } })
    const res = await app.inject({ method: 'POST', url: '/sessions/nope/knowledge/repo' })
    // The route's OWN handler ran (its session-scoped "session <id> not found"), proving the
    // RAG stack + knowledge routes were wired by the env-driven boot path — distinct from the
    // app's generic catch-all 404 ("not found") when the route isn't registered at all.
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toMatch(/^session .+ not found$/)
  })

  it('does NOT register the knowledge route when RAG is off (keyless in-memory default unchanged)', async () => {
    const app = buildServer({ keyStore: noKeyStore, env: { AUTH_JWT_SECRET: 's', AKIS_ALLOW_MOCK: '1' } })
    const res = await app.inject({ method: 'POST', url: '/sessions/nope/knowledge/repo' })
    expect(res.statusCode).toBe(404)
    // The route's OWN handler did NOT run — so we get some GENERIC 404, never the route's
    // session-scoped "session <id> not found". (Which generic 404 — the SPA catch-all's
    // "not found" vs Fastify's default "Not Found" — depends on whether a built frontend/dist
    // is present, so assert by what's ABSENT, not the exact generic message.)
    expect(res.json().error).not.toMatch(/^session .+ not found$/)
  })
})
