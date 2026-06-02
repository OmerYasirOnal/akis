import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serveStatic } from '../../src/preview/serveStatic.js'

let base: string
let dir: string
beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'akis-static-'))
  dir = join(base, 'ws')                     // the workspace root we serve from
  mkdirSync(dir)
  writeFileSync(join(dir, 'index.html'), '<h1>hello AKIS</h1>')
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)')
  // A secret OUTSIDE the served workspace — a traversal must never reach it.
  writeFileSync(join(base, 'secret.txt'), 'TOPSECRET')
})
afterAll(() => { rmSync(base, { recursive: true, force: true }) })

describe('serveStatic — static preview transport', () => {
  it('serves index.html for "/" with the html content-type', async () => {
    const r = await serveStatic(dir, '/')
    expect(r.code).toBe(200)
    expect(r.type).toMatch(/text\/html/)
    expect(r.body.toString()).toContain('hello AKIS')
  })

  it('serves a nested asset with its content-type', async () => {
    const r = await serveStatic(dir, '/assets/app.js')
    expect(r.code).toBe(200)
    expect(r.type).toMatch(/javascript/)
    expect(r.body.toString()).toContain('console.log')
  })

  it('extensionless paths fall back to index.html (SPA routing)', async () => {
    const r = await serveStatic(dir, '/some/client/route')
    expect(r.code).toBe(200)
    expect(r.body.toString()).toContain('hello AKIS')
  })

  it('never serves a file outside the workspace via "../" traversal', async () => {
    const r = await serveStatic(dir, '/../secret.txt')
    expect(r.body.toString()).not.toContain('TOPSECRET') // the security invariant
  })

  it('never serves outside via encoded ("%2e%2e") traversal', async () => {
    const r = await serveStatic(dir, '/assets/%2e%2e/%2e%2e/secret.txt')
    expect(r.body.toString()).not.toContain('TOPSECRET')
  })

  it('missing concrete asset → 404', async () => {
    const r = await serveStatic(dir, '/assets/missing.png')
    // missing asset with an extension does not SPA-fallback
    expect(r.code).toBe(404)
  })
})
