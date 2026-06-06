import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PreviewRegistry } from '../../src/preview/PreviewRegistry.js'
import { LocalDirectSandbox } from '../../src/exec/Sandbox.js'
import { makePreviewBoot } from '../../src/verify/previewBoot.js'
import { resolveVerifier } from '../../src/verify/verifier.js'
import type { RepoFile } from '../../src/di/MockGitHubAdapter.js'

/**
 * Move 2b — LIVE e2e proof of the behavioral round-trip (strategy DEPTH). Boots a REAL node:http
 * server through the PreviewRegistry and runs the FULL verifier path (resolveVerifier kind:'boot'
 * + roundTrip) over REAL HTTP — no fake fetch. A server that genuinely PERSISTS (POST appends, GET
 * reflects) mints a VerifyToken; a "Potemkin" server (POST 200 but stores nothing) does NOT. This
 * is the honest depth the signed passport claims, proven against an actually-running app.
 */
const API_SPEC = { title: 'Notes API', body: 'Given the API When I POST a note to /api/items Then GET /api/items returns it' }

/** A REAL node:http app that PERSISTS: POST /api/items appends the raw body, GET lists them. */
const PERSIST: RepoFile[] = [
  { filePath: 'package.json', content: JSON.stringify({ name: 'notes-persist', main: 'server.js' }) },
  { filePath: 'server.js', content: [
    "const http = require('node:http')",
    'let items = []',
    'const server = http.createServer((req, res) => {',
    "  if (req.url.startsWith('/api/items')) {",
    "    if (req.method === 'POST') {",
    "      let b = ''; req.on('data', c => { b += c }); req.on('end', () => {",
    '        items.push(b)',
    "        res.writeHead(201, { 'content-type': 'application/json' }); res.end('{\"ok\":true}')",
    '      }); return',
    '    }',
    "    res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ items }))",
    '  }',
    "  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><h1>Notes</h1>')",
    '})',
    "server.listen(Number(process.env.PORT ?? 3000), '127.0.0.1')",
  ].join('\n') },
]

/** A "Potemkin" node:http app: POST /api/items returns 200 but STORES NOTHING; GET stays empty. */
const POTEMKIN: RepoFile[] = [
  { filePath: 'package.json', content: JSON.stringify({ name: 'notes-potemkin', main: 'server.js' }) },
  { filePath: 'server.js', content: [
    "const http = require('node:http')",
    'const server = http.createServer((req, res) => {',
    "  if (req.url.startsWith('/api/items')) {",
    "    if (req.method === 'POST') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{\"ok\":true}') }",
    "    res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ items: [] }))",
    '  }',
    "  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><h1>Notes</h1>')",
    '})',
    "server.listen(Number(process.env.PORT ?? 3000), '127.0.0.1')",
  ].join('\n') },
]

describe('Move 2b: round-trip verify against a REALLY-booted node-service', () => {
  let wsDir: string
  let prevEnv: string | undefined
  let registry: PreviewRegistry
  beforeEach(() => {
    wsDir = mkdtempSync(join(tmpdir(), 'akis-rt-e2e-'))
    prevEnv = process.env.AKIS_WORKSPACES_DIR
    process.env.AKIS_WORKSPACES_DIR = wsDir
    registry = new PreviewRegistry({ sandbox: new LocalDirectSandbox() })
  })
  afterEach(async () => {
    await registry.stopAll()
    if (prevEnv === undefined) delete process.env.AKIS_WORKSPACES_DIR
    else process.env.AKIS_WORKSPACES_DIR = prevEnv
    rmSync(wsDir, { recursive: true, force: true })
  })

  it('PERSISTS → mints a VerifyToken (the round-trip ran against the real server and passed)', async () => {
    const verifier = resolveVerifier({ kind: 'boot', boot: makePreviewBoot(registry), roundTrip: true })
    const token = await verifier.verify('rt-persist', PERSIST, { spec: API_SPEC })
    expect(token, 'a persisting node-service must verify').not.toBeNull()
    // testsRun ≥ 2 ⇒ BOTH the always-on smoke probe AND the behavioral round-trip ran + passed.
    expect((token as unknown as { sessionId: string; testsRun: number }).sessionId).toBe('rt-persist')
    expect((token as unknown as { testsRun: number }).testsRun).toBeGreaterThanOrEqual(2)
  }, 90_000)

  it('POTEMKIN → NO token (POST 200 but nothing persisted → round-trip fails the run)', async () => {
    const verifier = resolveVerifier({ kind: 'boot', boot: makePreviewBoot(registry), roundTrip: true })
    const token = await verifier.verify('rt-potemkin', POTEMKIN, { spec: API_SPEC })
    expect(token, 'a Potemkin backend must NOT verify under round-trip').toBeNull()
  }, 90_000)

  it('Potemkin WITHOUT the flag still verifies (proves the round-trip is what caught it)', async () => {
    const verifier = resolveVerifier({ kind: 'boot', boot: makePreviewBoot(registry) }) // roundTrip OFF
    const token = await verifier.verify('rt-potemkin-off', POTEMKIN, { spec: API_SPEC })
    expect(token, 'without round-trip, the GET-only smoke probe passes the Potemkin app').not.toBeNull()
  }, 90_000)
})
