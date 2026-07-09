/**
 * B6-ii: the pipeline's push-failure `kind:'error'` emit must carry a machine code
 * ('PushFailed') so the FE can localize the error bubble — the message string stays
 * byte-identical (ADDITIVE observability only; the push gate itself is untouched).
 */
import { describe, it, expect } from 'vitest'
import { Orchestrator } from '../../src/orchestrator/Orchestrator.js'
import { MockSessionStore } from '../../src/store/MockSessionStore.js'
import { buildServices } from '../../src/di/services.js'
import { createMockTestRunner } from '../../src/verify/TestRunner.js'
import type { GitHubAdapter, RepoFile } from '../../src/di/MockGitHubAdapter.js'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/skills/library')

/** An adapter whose push always dies mid-delivery (transport error after createRepo). */
function failingAdapter(): GitHubAdapter {
  return {
    async createRepo(id: string): Promise<string> { return `https://github.com/mock/${id}` },
    async pushFiles(): Promise<void> { throw new Error('request to /git/blobs failed (HTTP 502)') },
    read(): RepoFile[] { return [] },
  }
}

describe("confirmPush failure — the error event carries code 'PushFailed' (B6-ii)", () => {
  it('emits kind:error with the machine code while the message stays the raw transport line', async () => {
    const store = new MockSessionStore()
    const services = buildServices({
      store, skillsDir, mockCriticScore: 90,
      testRunner: createMockTestRunner({ testsRun: 2, passed: true }),
    })
    services.github = failingAdapter()
    const orch = new Orchestrator(services)

    const s = await orch.start({ idea: 'todo app' })
    await orch.approve(s.id)
    await orch.runToVerification(s.id)
    await expect(orch.confirmPush(s.id)).rejects.toThrow()

    // The park behavior is unchanged (retryable push_failed)…
    expect((await store.get(s.id))?.status).toBe('push_failed')
    // …and the emitted error event now carries the machine code alongside the same message.
    const err = services.bus.recent(s.id).find(e => e.kind === 'error')
    expect(err).toBeDefined()
    expect((err as { code?: string }).code).toBe('PushFailed')
    expect((err as { message: string }).message).toMatch(/^push failed: /)
  })
})
