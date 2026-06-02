import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServer } from '../../src/api/server.js'
import type { KeyStore } from '../../src/keys/KeyStore.js'

const noKeyStore: KeyStore = { status: (p: string) => ({ provider: p, configured: false }), get: () => undefined, set: () => {}, remove: () => {}, list: () => [] }

let dist: string
beforeAll(() => {
  dist = mkdtempSync(join(tmpdir(), 'akis-spa-'))
  writeFileSync(join(dist, 'index.html'), '<!doctype html><html><body><div id="root">AKIS SPA</div></body></html>')
  mkdirSync(join(dist, 'assets'))
  writeFileSync(join(dist, 'assets', 'app.js'), 'console.log("akis")')
})
afterAll(() => { rmSync(dist, { recursive: true, force: true }) })

// SERVE_STATIC on + an explicit built-dist root → the SPA is served and the API stays JSON.
const spaApp = () =>
  buildServer({ keyStore: noKeyStore, env: { AUTH_JWT_SECRET: 'spa-secret', SERVE_STATIC: '1' }, staticRoot: dist })

describe('CONTRACT: single-container static SPA serving (self-host)', () => {
  it('GET / returns index.html (the SPA shell)', async () => {
    const app = spaApp()
    const res = await app.inject({ method: 'GET', url: '/' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/html/)
    expect(res.body).toContain('AKIS SPA')
  })

  it('a client deep-link (unknown non-API GET) falls back to index.html (SPA routing)', async () => {
    const app = spaApp()
    const res = await app.inject({ method: 'GET', url: '/workflows/abc/edit' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/html/)
    expect(res.body).toContain('AKIS SPA')
  })

  it('serves a real built asset with its own content-type (not the SPA shell)', async () => {
    const app = spaApp()
    const res = await app.inject({ method: 'GET', url: '/assets/app.js' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/javascript/)
    expect(res.body).toContain('console.log')
  })

  it('/health stays JSON (an API route is never shadowed by the SPA fallback)', async () => {
    const app = spaApp()
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/application\/json/)
    expect(res.json()).toEqual({ ok: true })
  })

  it('an unknown API path returns a JSON 404 (NOT the SPA index.html)', async () => {
    const app = spaApp()
    const res = await app.inject({ method: 'GET', url: '/api/workflows/does-not-exist-zzz/nope' })
    expect(res.statusCode).toBe(404)
    expect(res.headers['content-type']).toMatch(/application\/json/)
    expect(res.body).not.toContain('AKIS SPA')
  })

  it('a non-GET unknown route is a JSON 404, never the SPA shell', async () => {
    const app = spaApp()
    const res = await app.inject({ method: 'POST', url: '/totally/unknown/route' })
    expect(res.statusCode).toBe(404)
    expect(res.body).not.toContain('AKIS SPA')
  })

  it('with SERVE_STATIC unset and no built dist the static plugin is NOT registered (no behavior change)', async () => {
    // SERVE_STATIC unset → only auto-enable if a dist EXISTS. Point at a missing dir so
    // the default path is byte-for-byte unchanged (Fastify's default JSON 404).
    const app = buildServer({ keyStore: noKeyStore, env: { AUTH_JWT_SECRET: 'no-spa' }, staticRoot: join(dist, 'does-not-exist') })
    const res = await app.inject({ method: 'GET', url: '/' })
    // Default behavior: no SPA shell, Fastify's default JSON 404 for the unmatched route.
    expect(res.statusCode).toBe(404)
    expect(res.body).not.toContain('AKIS SPA')
  })
})
