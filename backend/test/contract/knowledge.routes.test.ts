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
import type { OrchestratorServices } from '../../src/di/services.js'
import type { FastifyInstance } from 'fastify'

const skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/skills/library')
const noKeyStore: KeyStore = { status: (p: string) => ({ provider: p, configured: false }), get: () => undefined, set: () => {}, remove: () => {}, list: () => [] }

/** Build a multipart/form-data body with a single `file` part — the exact shape
 *  @fastify/multipart parses (filename + content-type drive type detection). */
function multipartFile(filename: string, contentType: string, content: string | Buffer): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----akistest' + Math.random().toString(36).slice(2)
  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`
  const tail = `\r\n--${boundary}--\r\n`
  const body = typeof content === 'string' ? Buffer.from(content) : content
  const payload = Buffer.concat([Buffer.from(head), body, Buffer.from(tail)])
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } }
}

/** A RAG-on server built from explicit services (so the test holds the queue/port handles
 *  for a deterministic drain + retrieve). Auth via AUTH_JWT_SECRET so sessions are owned. */
function ragApp(opts: { uploadMaxBytes?: string } = {}): { app: FastifyInstance; services: OrchestratorServices } {
  const services = buildServices({
    store: new MockSessionStore(), skillsDir, provider: new MockProvider(),
    testRunner: createMockTestRunner({ testsRun: 2, passed: true }), rag: true,
  })
  const orchestrator = new Orchestrator(services)
  const env: Record<string, string | undefined> = { AUTH_JWT_SECRET: 'know-secret', ...(opts.uploadMaxBytes ? { AKIS_UPLOAD_MAX_BYTES: opts.uploadMaxBytes } : {}) }
  const app = buildServer({ keyStore: noKeyStore, services, orchestrator, env })
  return { app, services }
}

const cookieOf = (res: { headers: Record<string, unknown> }): string => String(res.headers['set-cookie']).split(';')[0]!
const signup = (app: FastifyInstance, email: string) =>
  app.inject({ method: 'POST', url: '/auth/signup', payload: { name: 'U', email, password: 'password1234' } })
const startOwned = async (app: FastifyInstance, cookie: string, idea: string): Promise<string> => {
  const body = (await app.inject({ method: 'POST', url: '/sessions', payload: { idea }, headers: { cookie } })).json() as { id: string }
  return body.id
}

describe('CONTRACT: knowledge upload route (issue #7 AC2/AC5)', () => {
  it('multipart text upload → 202 and is retrievable after the queue drains (round-trip)', async () => {
    const { app, services } = ragApp()
    const ada = cookieOf(await signup(app, 'ada-up@akis.dev'))
    const id = await startOwned(app, ada, 'kb app')

    const mp = multipartFile('notes.md', 'text/markdown', '# Notes\n\npostgres database migration design decisions and schema')
    const up = await app.inject({ method: 'POST', url: `/sessions/${id}/knowledge/uploads`, headers: { ...mp.headers, cookie: ada }, payload: mp.payload })
    expect(up.statusCode).toBe(202)

    // Drain the ingestion queue deterministically, then the uploaded content is
    // retrievable through the SAME knowledge port an agent reads (round-trip, AC2).
    await services.ragQueue!.drain()
    const hits = await services.knowledge.retrieve({ query: 'postgres database migration schema', sessionId: id, limit: 5 })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.some(h => h.source === 'upload:notes.md')).toBe(true)
  })

  it('non-owner upload to an owned session → 404 (hides existence, like sessions.routes)', async () => {
    const { app } = ragApp()
    const ada = cookieOf(await signup(app, 'ada-x@akis.dev'))
    const bo = cookieOf(await signup(app, 'bo-x@akis.dev'))
    const id = await startOwned(app, ada, 'ada kb')

    const mp = multipartFile('notes.md', 'text/markdown', 'some prose content here')
    expect((await app.inject({ method: 'POST', url: `/sessions/${id}/knowledge/uploads`, headers: { ...mp.headers, cookie: bo }, payload: mp.payload })).statusCode).toBe(404)
    const mp2 = multipartFile('notes.md', 'text/markdown', 'some prose content here')
    expect((await app.inject({ method: 'POST', url: `/sessions/${id}/knowledge/uploads`, headers: mp2.headers, payload: mp2.payload })).statusCode).toBe(404)
  })

  it('unsupported type (an image) → 415, nothing ingested', async () => {
    const { app, services } = ragApp()
    const ada = cookieOf(await signup(app, 'ada-415@akis.dev'))
    const id = await startOwned(app, ada, 'kb 415')

    const mp = multipartFile('logo.png', 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    const res = await app.inject({ method: 'POST', url: `/sessions/${id}/knowledge/uploads`, headers: { ...mp.headers, cookie: ada }, payload: mp.payload })
    expect(res.statusCode).toBe(415)
    // A rejected upload never mutates the corpus: no upload:logo.png chunk exists (the
    // session's own zero-touch narration may be present, but the upload itself is not).
    await services.ragQueue!.drain()
    expect(services.ragService!.deleteBySource('upload', 'logo.png')).toBe(0)
  })

  it('oversized upload → 413 (size limit enforced)', async () => {
    const { app } = ragApp({ uploadMaxBytes: '1024' })
    const ada = cookieOf(await signup(app, 'ada-413@akis.dev'))
    const id = await startOwned(app, ada, 'kb 413')

    const mp = multipartFile('big.txt', 'text/plain', 'x'.repeat(4096))
    const res = await app.inject({ method: 'POST', url: `/sessions/${id}/knowledge/uploads`, headers: { ...mp.headers, cookie: ada }, payload: mp.payload })
    expect(res.statusCode).toBe(413)
  })

  it('the route is absent (404) when AKIS_RAG is off', async () => {
    const services = buildServices({ store: new MockSessionStore(), skillsDir, provider: new MockProvider() })
    const app = buildServer({ keyStore: noKeyStore, services, orchestrator: new Orchestrator(services), env: { AUTH_JWT_SECRET: 'off-secret' } })
    const id = (await app.inject({ method: 'POST', url: '/sessions', payload: { idea: 'no-rag app' } })).json().id
    const mp = multipartFile('notes.md', 'text/markdown', 'content')
    const res = await app.inject({ method: 'POST', url: `/sessions/${id}/knowledge/uploads`, headers: mp.headers, payload: mp.payload })
    expect(res.statusCode).toBe(404)
  })
})

describe('CONTRACT: repo ingest trigger (issue #7 AC1)', () => {
  it('the owner triggers an incremental pass; pushed repo files become retrievable; non-owner → 404', async () => {
    const { app, services } = ragApp()
    const ada = cookieOf(await signup(app, 'ada-repo@akis.dev'))
    const bo = cookieOf(await signup(app, 'bo-repo@akis.dev'))
    const id = await startOwned(app, ada, 'repo kb')

    // Push a repo file set into the SHARED MockGitHubAdapter the RepoSource reads.
    await services.github.pushFiles(id, [{ filePath: 'README.md', content: 'redis caching ttl eviction layer and rate limiting' }])

    // A non-owner cannot trigger a repo pass on an owned session.
    expect((await app.inject({ method: 'POST', url: `/sessions/${id}/knowledge/repo`, headers: { cookie: bo } })).statusCode).toBe(404)

    // The owner triggers a pass → 202; after draining, the repo file is retrievable.
    const res = await app.inject({ method: 'POST', url: `/sessions/${id}/knowledge/repo`, headers: { cookie: ada } })
    expect(res.statusCode).toBe(202)
    await services.ragQueue!.drain()
    const hits = await services.knowledge.retrieve({ query: 'redis caching eviction', sessionId: id, limit: 5 })
    expect(hits.some(h => h.source === 'repo:README.md')).toBe(true)
  })
})
