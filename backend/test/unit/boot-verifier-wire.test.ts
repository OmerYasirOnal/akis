import { describe, it, expect, vi } from 'vitest'
import { resolveVerifier } from '../../src/verify/verifier.js'
import { Orchestrator } from '../../src/orchestrator/Orchestrator.js'
import { MockSessionStore } from '../../src/store/MockSessionStore.js'
import { buildServices } from '../../src/di/services.js'
import type { BootResult, ProbeResponse } from '../../src/verify/bootSmoke.js'
import type { RepoFile } from '../../src/di/MockGitHubAdapter.js'
import { isVerified } from '@akis/shared'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/skills/library')

const VITE_FILES: RepoFile[] = [
  { filePath: 'package.json', content: JSON.stringify({ name: 'x', devDependencies: { vite: '^5' } }) },
  { filePath: 'index.html', content: '<!doctype html><div id="app"></div>' },
]
const OK: ProbeResponse = { status: 200, body: '<html>hello</html>' }

describe('resolveVerifier kind:boot (PR2 wiring)', () => {
  it('is a LIVE verifier (demo:false) and mints a token from a genuinely booted+probed app', async () => {
    const teardown = vi.fn(async () => {})
    const bootIds: string[] = []
    const boot = async (sessionId: string): Promise<BootResult> => { bootIds.push(sessionId); return { url: 'http://127.0.0.1:1', teardown } }
    const v = resolveVerifier({ kind: 'boot', boot, fetchImpl: async () => OK })
    expect(v.demo).toBe(false)
    const token = await v.verify('sess-1', VITE_FILES)
    expect(token).not.toBeNull()
    expect(token!.testsRun).toBeGreaterThanOrEqual(1)
    // The verify() SESSION ID reached the boot adapter per-run (no DI-time static needed).
    expect(bootIds).toEqual(['sess-1'])
    expect(teardown).toHaveBeenCalledTimes(1)
  })

  it('fail-closed end to end: a failed boot yields NO token', async () => {
    const v = resolveVerifier({ kind: 'boot', boot: async () => ({ failed: 'no boot' }), fetchImpl: async () => OK })
    expect(await v.verify('sess-2', VITE_FILES)).toBeNull()
  })

  it('the per-run spec (RunOptions.spec) derives criteria probes — overriding any DI-time static', async () => {
    const urls: string[] = []
    const fetchImpl = async (url: string): Promise<ProbeResponse> => { urls.push(url); return OK }
    const v = resolveVerifier({ kind: 'boot', boot: async () => ({ url: 'http://h', teardown: async () => {} }), fetchImpl })
    const spec = { title: 'T', body: 'Given the api When I call it Then GET /api/items works' }
    const token = await v.verify('sess-3', VITE_FILES, { spec })
    expect(token).not.toBeNull()
    // smoke '/' + the derived '/api/items' probe — the spec genuinely shaped what was probed.
    expect(urls.some(u => u.endsWith('/api/items'))).toBe(true)
  })
})

describe('Orchestrator → Trace → verifier spec threading (PR2)', () => {
  it('the approved spec flows per-run into the runner (capturing testRunner sees opts.spec + opts.sessionId)', async () => {
    const store = new MockSessionStore()
    const seen: { spec?: { title: string }; sessionId?: string }[] = []
    // The DI-owned runner seam (kind:'runner') — createVerifier forwards opts unchanged, so
    // this capturing runner observes EXACTLY what the boot-smoke runner would receive.
    const testRunner = {
      async run(_files: RepoFile[], opts?: { spec?: { title: string }; sessionId?: string }) {
        seen.push({ ...(opts?.spec ? { spec: { title: opts.spec.title } } : {}), ...(opts?.sessionId ? { sessionId: opts.sessionId } : {}) })
        // Mint via the trusted mock path is not available here — return a passing shape the
        // brand seam produces: reuse createMockTestRunner instead for the branded result.
        const { createMockTestRunner } = await import('../../src/verify/TestRunner.js')
        return createMockTestRunner({ testsRun: 2, passed: true }).run(_files)
      },
    }
    const services = buildServices({ store, skillsDir, mockCriticScore: 90, testRunner })
    const orch = new Orchestrator(services)
    const s = await orch.start({ idea: 'a todo app' })
    await orch.approve(s.id)
    await orch.runToVerification(s.id)
    const after = (await store.get(s.id))!
    expect(isVerified(after)).toBe(true)
    // The runner saw the run's spec + the session id, per-run (PR2 threading, end to end).
    expect(seen.length).toBeGreaterThanOrEqual(1)
    expect(seen[0]!.sessionId).toBe(s.id)
    expect(seen[0]!.spec?.title).toBeTruthy()
  })
})
