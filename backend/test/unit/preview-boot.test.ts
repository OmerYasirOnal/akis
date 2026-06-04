import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makePreviewBoot } from '../../src/verify/previewBoot.js'
import type { PreviewRegistry } from '../../src/preview/PreviewRegistry.js'
import type { RepoFile } from '../../src/di/MockGitHubAdapter.js'

const VITE_FILES: RepoFile[] = [
  { filePath: 'package.json', content: JSON.stringify({ name: 'x', devDependencies: { vite: '^5' } }) },
  { filePath: 'index.html', content: '<!doctype html><div id="app"></div>' },
]
const STATIC_FILES: RepoFile[] = [
  { filePath: 'index.html', content: '<!doctype html><html><body><h1>Hello Static</h1></body></html>' },
  { filePath: 'styles.css', content: 'body{color:red}' },
]

/** A fake registry that records every start/stop id and reports ready on a fixed port. */
function fakeRegistry() {
  const startedIds: string[] = []
  const stoppedIds: string[] = []
  const registry = {
    async start(id: string) { startedIds.push(id); return { sessionId: id, status: 'ready' as const, url: `/preview/${id}/` } },
    portFor(_id: string) { return 4321 },
    async stop(id: string) { stoppedIds.push(id) },
  } as unknown as PreviewRegistry
  return { registry, startedIds, stoppedIds }
}

describe('makePreviewBoot', () => {
  it('boots under a UNIQUE per-run verify id — two concurrent verifies of the SAME session never collide (PR #94 review)', async () => {
    const { registry, startedIds } = fakeRegistry()
    const boot = makePreviewBoot(registry)
    // Two concurrent verifies of the same session (e.g. a retry racing a stale run):
    // with a shared id the second start() would silently kill the first boot mid-probe.
    const [a, b] = await Promise.all([boot('s1', VITE_FILES), boot('s1', VITE_FILES)])
    expect('url' in a! && 'url' in b!).toBe(true)
    expect(startedIds).toHaveLength(2)
    expect(startedIds[0]).not.toBe(startedIds[1])
    expect(startedIds.every(id => id.includes('s1#verify-'))).toBe(true)
  })

  it('teardown stops EXACTLY the verify entry it booted (independent lifecycles)', async () => {
    const { registry, startedIds, stoppedIds } = fakeRegistry()
    const boot = makePreviewBoot(registry)
    const r = await boot('s2', VITE_FILES)
    if (!('url' in r)) throw new Error('expected a ready boot')
    expect(r.url).toBe('http://127.0.0.1:4321')
    await r.teardown()
    expect(stoppedIds).toEqual([startedIds[0]])
  })
})

describe('makePreviewBoot — STATIC apps (PR3: the most common Proto output is verifiable)', () => {
  let wsDir: string
  let prevEnv: string | undefined
  beforeEach(() => {
    // materialize() writes under AKIS_WORKSPACES_DIR — point it at a throwaway tmp dir so
    // tests never touch the real ~/.akis/workspaces.
    wsDir = mkdtempSync(join(tmpdir(), 'akis-verify-ws-'))
    prevEnv = process.env.AKIS_WORKSPACES_DIR
    process.env.AKIS_WORKSPACES_DIR = wsDir
  })
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.AKIS_WORKSPACES_DIR
    else process.env.AKIS_WORKSPACES_DIR = prevEnv
    rmSync(wsDir, { recursive: true, force: true })
  })

  it('serves the materialized app over a REAL loopback HTTP server; teardown closes it + removes the workspace', async () => {
    const { registry, startedIds } = fakeRegistry()
    const boot = makePreviewBoot(registry)
    const r = await boot('st1', STATIC_FILES)
    if (!('url' in r)) throw new Error(`expected a ready static boot, got: ${JSON.stringify(r)}`)
    // The registry is NOT involved for static (no process to manage).
    expect(startedIds).toHaveLength(0)
    // REAL observations: `/` falls back to index.html; assets serve; a miss is 404 (which the
    // boot-smoke <400 rule honestly fails); traversal cannot escape the workspace.
    const home = await fetch(r.url)
    expect(home.status).toBe(200)
    expect(await home.text()).toContain('Hello Static')
    expect((await fetch(`${r.url}/styles.css`)).status).toBe(200)
    expect((await fetch(`${r.url}/missing.html`)).status).toBe(404)
    expect((await fetch(`${r.url}/..%2f..%2fetc%2fpasswd`)).status).toBe(404)
    // Teardown: server closed (connection refused) + workspace dir removed.
    await r.teardown()
    await expect(fetch(r.url)).rejects.toThrow()
    expect(readdirSync(wsDir)).toHaveLength(0)
  })
})
