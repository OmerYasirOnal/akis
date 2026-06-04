import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PreviewRegistry } from '../../src/preview/PreviewRegistry.js'
import { LocalDirectSandbox } from '../../src/exec/Sandbox.js'
import { materialize } from '../../src/preview/Workspace.js'
import { detectAppType } from '../../src/preview/AppDetector.js'
import { makePreviewBoot } from '../../src/verify/previewBoot.js'
import { runBootSmoke } from '../../src/verify/bootSmoke.js'
import type { RepoFile } from '../../src/di/MockGitHubAdapter.js'

/**
 * Phase F acceptance (plan §3): a GENERATED-STYLE node-service — exactly the shape
 * PROTO_SYSTEM rule 3 mandates (server.js on the Node standard library, zero deps,
 * package.json main, listens on process.env.PORT, serves the client at `/` and a JSON
 * API under `/api/...`) — REALLY boots through the PreviewRegistry (real spawn, real
 * install, real two-phase probe) and answers HTTP 200 within a bounded time.
 */
const NODE_SERVICE: RepoFile[] = [
  {
    filePath: 'package.json',
    content: JSON.stringify({ name: 'phase-f-acceptance', main: 'server.js' }),
  },
  {
    filePath: 'server.js',
    content: [
      "const http = require('node:http')",
      "let items = ['seeded']",
      'const server = http.createServer((req, res) => {',
      "  if (req.url.startsWith('/api/items')) {",
      "    res.writeHead(200, { 'content-type': 'application/json' })",
      '    return res.end(JSON.stringify({ items }))',
      '  }',
      "  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })",
      "  res.end('<!doctype html><html><body><h1>Phase F</h1><script src=\"./app.js\" defer></script></body></html>')",
      '})',
      "server.listen(Number(process.env.PORT ?? 3000), '127.0.0.1')",
    ].join('\n'),
  },
]

describe('Phase F: a generated-style node-service REALLY boots and serves', () => {
  let wsDir: string
  let prevEnv: string | undefined
  let registry: PreviewRegistry
  beforeEach(() => {
    wsDir = mkdtempSync(join(tmpdir(), 'akis-nodeservice-'))
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

  it('detects node-service, installs (scripts blocked), boots, and answers / AND /api within the budget', async () => {
    expect(detectAppType(NODE_SERVICE)).toBe('node-service')
    const dir = await materialize('nsvc-1', NODE_SERVICE)
    const started = Date.now()
    const entry = await registry.start('nsvc-1', dir, 'node-service')
    expect(entry.status, entry.reason ?? '').toBe('ready')
    expect(Date.now() - started).toBeLessThan(60_000) // bounded: install (dep-less) + boot + probe
    const port = registry.portFor('nsvc-1')!
    // The REAL running server answers: client at `/`, JSON API under `/api/...`.
    const home = await fetch(`http://127.0.0.1:${port}/`)
    expect(home.status).toBe(200)
    expect(await home.text()).toContain('Phase F')
    const api = await fetch(`http://127.0.0.1:${port}/api/items`)
    expect(api.status).toBe(200)
    expect(await api.json()).toEqual({ items: ['seeded'] })
    // Teardown: process group killed → the port stops answering.
    await registry.stop('nsvc-1')
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow()
  }, 90_000)

  it('boot-smoke VERIFIES the same node-service end to end (boot → probes → pass), teardown clean', async () => {
    const boot = makePreviewBoot(registry)
    const res = await runBootSmoke(NODE_SERVICE, {
      boot,
      sessionId: 'nsvc-2',
      spec: { title: 'Phase F', body: 'Given the service When I GET /api/items Then it works' },
    })
    // A genuine pass: smoke `/` + the ./app.js asset probe FAILS? No — server serves every path
    // as HTML 200 (the SPA-style fallback above), so the asset answers too. Criteria probe hits
    // /api/items for real. ≥1 test, zero failures ⇒ verifiable.
    expect(res.e2eScenarios.map(s => `${s.name}:${s.passed}`).join(',')).toContain('app boots and serves /:true')
    expect(res.passed).toBe(true)
    expect(res.testsRun).toBeGreaterThanOrEqual(2)
  }, 90_000)
})
