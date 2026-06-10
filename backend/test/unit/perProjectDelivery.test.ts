/**
 * A2.1 — per-PROJECT GitHub delivery: the run derives a repo name from the project title, PINS it
 * to the session at awaiting_push_confirm (so the FE shows it before confirm), reuses the SAME repo
 * on retry, suffixes deterministically on collision, and confirmPush pushes to the PINNED repo via
 * the per-user adapter. The push gate (Gate 4) is untouched — these only prove WHERE the already-
 * gated push lands and that the destination is pinned/derived correctly.
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

/** A spy adapter recording the destination it was resolved for + whether it pushed. */
function spyAdapter(tag: string): GitHubAdapter & { pushed: boolean; createdRepo: boolean } {
  const a = {
    tag, pushed: false, createdRepo: false,
    async createRepo(_id: string): Promise<string> { a.createdRepo = true; return `https://github.com/${tag}` },
    async pushFiles(_id: string, _files: RepoFile[]): Promise<void> { a.pushed = true },
    read(_id: string): RepoFile[] { return [] },
  }
  return a
}

/** Drive a fresh session to awaiting_push_confirm (verified), with an explicit spec title. */
async function verifiedSession(orch: Orchestrator, ownerId: string, idea: string): Promise<string> {
  const s = await orch.start({ idea, ownerId })
  await orch.approve(s.id)
  const after = await orch.runToVerification(s.id)
  expect(after.status).toBe('awaiting_push_confirm')
  return s.id
}

describe('A2.1 — destination pinning + resolution order', () => {
  it('PINS the derived destination on the session at awaiting_push_confirm (FE can show it before confirm)', async () => {
    const store = new MockSessionStore()
    const services = buildServices({ store, skillsDir, mockCriticScore: 90, testRunner: createMockTestRunner({ testsRun: 2, passed: true }) })
    let calls = 0
    services.deliveryFor = async () => { calls++; return { owner: 'ada', repo: 'todo-app' } }
    const orch = new Orchestrator(services)

    const id = await verifiedSession(orch, 'owner-1', 'todo app')
    const pinned = await store.get(id)
    expect(pinned?.delivery).toEqual({ owner: 'ada', repo: 'todo-app' })
    expect(calls).toBe(1) // derived ONCE at the verify-transition

    // The push_confirm AWAITING gate event carries the destination so the gate card can render it.
    const gate = services.bus.recent(id).find(e => e.kind === 'gate' && e.gate === 'push_confirm' && e.state === 'awaiting')
    expect(gate && (gate as { delivery?: unknown }).delivery).toEqual({ owner: 'ada', repo: 'todo-app' })
  })

  it('REUSES the pinned destination on a push_failed RETRY — never re-derives a (possibly new) repo', async () => {
    const store = new MockSessionStore()
    const services = buildServices({ store, skillsDir, mockCriticScore: 90, testRunner: createMockTestRunner({ testsRun: 2, passed: true }) })
    let calls = 0
    services.deliveryFor = async () => { calls++; return { owner: 'ada', repo: `repo-${calls}` } }
    // First push fails (adapter throws), parking push_failed; the retry then succeeds.
    let fail = true
    const userAdapter: GitHubAdapter = {
      async createRepo(_id) { return 'https://github.com/ada/repo-1' },
      async pushFiles(_id, _f) { if (fail) throw new Error('transient'); },
      read() { return [] },
    }
    let lastDelivery: { owner: string; repo: string } | undefined
    services.githubFor = (_o, d) => { lastDelivery = d; return userAdapter }
    const orch = new Orchestrator(services)

    const id = await verifiedSession(orch, 'owner-1', 'todo app')
    expect((await store.get(id))?.delivery).toEqual({ owner: 'ada', repo: 'repo-1' })
    expect(calls).toBe(1) // derived ONCE at verify-transition

    await expect(orch.confirmPush(id)).rejects.toThrow() // first push fails → push_failed
    expect((await store.get(id))?.status).toBe('push_failed')

    fail = false
    const done = await orch.confirmPush(id) // retry — reuses the PINNED repo
    expect(done.status).toBe('done')
    expect(lastDelivery).toEqual({ owner: 'ada', repo: 'repo-1' })
    // deliveryFor was NEVER called again (the pin is reused), so the repo can't drift to repo-2/3.
    expect(calls).toBe(1)
  })

  it('does NOT pin for an anonymous session (no ownerId) — env→mock path unchanged', async () => {
    const store = new MockSessionStore()
    const services = buildServices({ store, skillsDir, mockCriticScore: 90, testRunner: createMockTestRunner({ testsRun: 2, passed: true }) })
    let calls = 0
    services.deliveryFor = async () => { calls++; return { owner: 'ada', repo: 'x' } }
    const orch = new Orchestrator(services)

    const s = await orch.start({ idea: 'anon app' }) // no ownerId
    await orch.approve(s.id)
    const after = await orch.runToVerification(s.id)
    expect(after.status).toBe('awaiting_push_confirm')
    expect(after.delivery).toBeUndefined()
    expect(calls).toBe(0) // never consulted without an owner
  })

  it('does NOT pin when deliveryFor returns undefined (no usable connection) — leaves env→mock/refusal path', async () => {
    const store = new MockSessionStore()
    const services = buildServices({ store, skillsDir, mockCriticScore: 90, testRunner: createMockTestRunner({ testsRun: 2, passed: true }) })
    services.deliveryFor = async () => undefined
    const orch = new Orchestrator(services)

    const id = await verifiedSession(orch, 'owner-1', 'todo app')
    expect((await store.get(id))?.delivery).toBeUndefined()
  })
})

describe('A2.1 — confirmPush pushes to the PINNED per-project repo via the user adapter', () => {
  it('passes the pinned delivery to githubFor and pushes through THAT adapter', async () => {
    const store = new MockSessionStore()
    const shared = spyAdapter('shared-env')
    const userAdapter = spyAdapter('ada/todo-app')
    const services = buildServices({ store, skillsDir, mockCriticScore: 90, testRunner: createMockTestRunner({ testsRun: 2, passed: true }) })
    services.github = shared
    services.deliveryFor = async () => ({ owner: 'ada', repo: 'todo-app' })
    // Capture the delivery githubFor receives — proving confirmPush resolves it from the pin.
    let receivedDelivery: { owner: string; repo: string } | undefined
    services.githubFor = (_ownerId, delivery) => { receivedDelivery = delivery; return userAdapter }
    const orch = new Orchestrator(services)

    const id = await verifiedSession(orch, 'owner-1', 'todo app')
    const done = await orch.confirmPush(id)
    expect(done.status).toBe('done')
    expect(receivedDelivery).toEqual({ owner: 'ada', repo: 'todo-app' })
    expect(userAdapter.pushed).toBe(true)
    expect(userAdapter.createdRepo).toBe(true)
    expect(shared.pushed).toBe(false)
    // The terminal record still carries the pinned destination.
    expect(done.delivery).toEqual({ owner: 'ada', repo: 'todo-app' })
  })
})
