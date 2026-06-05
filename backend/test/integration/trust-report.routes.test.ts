import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildServer } from '../../src/api/server.js'
import { JsonFileKeyStore } from '../../src/keys/KeyStore.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MASTER = '0'.repeat(64)
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'akis-report-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const app = () => buildServer({ keyStore: new JsonFileKeyStore(join(dir, 'keys.json'), MASTER, () => '2026-06-01T00:00:00Z'), env: { AUTH_JWT_SECRET: 'report-secret', AKIS_DEMO_VERIFY: '1' } })
const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie']).split(';')[0]!
const signup = (s: ReturnType<typeof app>, email: string) =>
  s.inject({ method: 'POST', url: '/auth/signup', payload: { name: 'U', email, password: 'password1234' } })

/** Drive a full mock-pipeline run to done (spec approve → run → confirm push). */
async function runToDone(s: ReturnType<typeof app>, cookie: string): Promise<string> {
  const created = await s.inject({ method: 'POST', url: '/sessions', payload: { idea: 'a todo app' }, headers: { cookie } })
  const id = created.json().id as string
  await s.inject({ method: 'POST', url: `/sessions/${id}/approve`, headers: { cookie } })
  await s.inject({ method: 'POST', url: `/sessions/${id}/run`, headers: { cookie } })
  await s.inject({ method: 'POST', url: `/sessions/${id}/confirm`, headers: { cookie } })
  return id
}

describe('GET /sessions/:id/report (the client-facing trust report)', () => {
  it('a finished run yields a structured report whose facts mirror the session (and demo runs are labeled simulated)', async () => {
    const s = app()
    const ada = cookieOf(await signup(s, 'ada@akis.dev'))
    const id = await runToDone(s, ada)
    const res = await s.inject({ method: 'GET', url: `/sessions/${id}/report`, headers: { cookie: ada } })
    expect(res.statusCode).toBe(200)
    const r = res.json()
    expect(r.project.sessionId).toBe(id)
    expect(r.delivery.status).toBe('done')
    expect(r.spec.approvedAt).toBeTruthy()
    expect(r.delivery.pushConfirmedAt).toBeTruthy()
    expect(r.disclaimer).toContain('not a guarantee')
    // The default test pipeline is the MOCK runner ⇒ the report must be HONEST about it:
    // simulated true and verified false, even though the mock "passed".
    expect(r.verification.simulated).toBe(true)
    expect(r.verification.verified).toBe(false)
    // The durable path too (review #113): the PERSISTED evidence carries demo, so the
    // label survives ring-buffer eviction on long sessions.
    const sess = await s.inject({ method: 'GET', url: `/sessions/${id}`, headers: { cookie: ada } })
    expect(sess.json().testEvidence?.demo).toBe(true)
  })

  it('?format=md returns a downloadable Markdown artifact', async () => {
    const s = app()
    const ada = cookieOf(await signup(s, 'ada3@akis.dev'))
    const id = await runToDone(s, ada)
    const res = await s.inject({ method: 'GET', url: `/sessions/${id}/report?format=md`, headers: { cookie: ada } })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/markdown')
    expect(res.headers['content-disposition']).toContain(`trust-report-${id}.md`)
    expect(res.body).toContain('# Trust Report —')
    expect(res.body).toContain('SIMULATED')
  })

  it('owner-scoped: another user (or anonymous) gets 404, never the report', async () => {
    const s = app()
    const ada = cookieOf(await signup(s, 'ada2@akis.dev'))
    const bo = cookieOf(await signup(s, 'bo2@akis.dev'))
    const id = await runToDone(s, ada)
    expect((await s.inject({ method: 'GET', url: `/sessions/${id}/report`, headers: { cookie: bo } })).statusCode).toBe(404)
    expect((await s.inject({ method: 'GET', url: `/sessions/${id}/report` })).statusCode).toBe(404)
  })

  it('unknown session → 404', async () => {
    expect((await app().inject({ method: 'GET', url: '/sessions/nope/report' })).statusCode).toBe(404)
  })
})
