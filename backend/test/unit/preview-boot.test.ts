import { describe, it, expect } from 'vitest'
import { makePreviewBoot } from '../../src/verify/previewBoot.js'
import type { PreviewRegistry } from '../../src/preview/PreviewRegistry.js'
import type { RepoFile } from '../../src/di/MockGitHubAdapter.js'

const VITE_FILES: RepoFile[] = [
  { filePath: 'package.json', content: JSON.stringify({ name: 'x', devDependencies: { vite: '^5' } }) },
  { filePath: 'index.html', content: '<!doctype html><div id="app"></div>' },
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
