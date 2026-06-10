/**
 * Per-OWNER push-adapter precedence (TIGHTEN-ONLY): confirmPush prefers the session owner's
 * connected adapter when `githubFor(ownerId)` resolves one, else falls back to the shared
 * `services.github` (env token → mock) EXACTLY as today. The push gate is untouched — this
 * only proves WHICH already-gated adapter is consumed by the unchanged pushToGitHub path.
 */
import { describe, it, expect } from 'vitest'
import { Orchestrator, NoGitHubDestinationError } from '../../src/orchestrator/Orchestrator.js'
import { MockSessionStore } from '../../src/store/MockSessionStore.js'
import { buildServices } from '../../src/di/services.js'
import { createMockTestRunner } from '../../src/verify/TestRunner.js'
import { MockGitHubAdapter, type GitHubAdapter, type RepoFile } from '../../src/di/MockGitHubAdapter.js'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/skills/library')

/** A spy adapter recording which instance actually pushed. */
function spyAdapter(tag: string): GitHubAdapter & { pushed: boolean; createdRepo: boolean } {
  const a = {
    tag,
    pushed: false,
    createdRepo: false,
    async createRepo(_id: string): Promise<string> { a.createdRepo = true; return `https://github.com/${tag}` },
    async pushFiles(_id: string, _files: RepoFile[]): Promise<void> { a.pushed = true },
    read(_id: string): RepoFile[] { return [] },
  }
  return a
}

/** Drive a fresh session all the way to awaiting_push_confirm (verified). */
async function verifiedSession(orch: Orchestrator, ownerId?: string): Promise<string> {
  const s = await orch.start({ idea: 'todo app', ...(ownerId ? { ownerId } : {}) })
  await orch.approve(s.id)
  const after = await orch.runToVerification(s.id)
  expect(after.status).toBe('awaiting_push_confirm')
  return s.id
}

describe('confirmPush — per-owner adapter precedence', () => {
  it('pushes through the OWNER adapter when githubFor resolves one (user > env/mock)', async () => {
    const store = new MockSessionStore()
    const shared = spyAdapter('shared-env')
    const userAdapter = spyAdapter('owner-repo')
    const services = buildServices({ store, skillsDir, mockCriticScore: 90, testRunner: createMockTestRunner({ testsRun: 2, passed: true }) })
    // Inject the shared adapter + a per-owner resolver (what server wiring does in prod).
    services.github = shared
    services.githubFor = (ownerId: string) => (ownerId === 'owner-1' ? userAdapter : undefined)
    const orch = new Orchestrator(services)

    const id = await verifiedSession(orch, 'owner-1')
    const done = await orch.confirmPush(id)
    expect(done.status).toBe('done')
    expect(userAdapter.pushed).toBe(true)
    expect(userAdapter.createdRepo).toBe(true)
    expect(shared.pushed).toBe(false) // the shared env/mock adapter was NOT used
  })

  it('falls back to the shared adapter when githubFor returns undefined for the owner', async () => {
    const store = new MockSessionStore()
    const shared = spyAdapter('shared-env')
    const services = buildServices({ store, skillsDir, mockCriticScore: 90, testRunner: createMockTestRunner({ testsRun: 2, passed: true }) })
    services.github = shared
    services.githubFor = (_ownerId: string) => undefined // owner has no usable connection
    const orch = new Orchestrator(services)

    const id = await verifiedSession(orch, 'owner-1')
    await orch.confirmPush(id)
    expect(shared.pushed).toBe(true)
  })

  it('uses the shared adapter for an anonymous session (no ownerId) even when githubFor exists', async () => {
    const store = new MockSessionStore()
    const shared = spyAdapter('shared-env')
    const userAdapter = spyAdapter('owner-repo')
    const services = buildServices({ store, skillsDir, mockCriticScore: 90, testRunner: createMockTestRunner({ testsRun: 2, passed: true }) })
    services.github = shared
    services.githubFor = () => userAdapter // would resolve, but there is no ownerId to key on
    const orch = new Orchestrator(services)

    const id = await verifiedSession(orch /* no ownerId */)
    await orch.confirmPush(id)
    expect(shared.pushed).toBe(true)
    expect(userAdapter.pushed).toBe(false)
  })

  it('uses the shared adapter when githubFor is absent entirely (today\'s default)', async () => {
    const store = new MockSessionStore()
    const shared = spyAdapter('shared-env')
    const services = buildServices({ store, skillsDir, mockCriticScore: 90, testRunner: createMockTestRunner({ testsRun: 2, passed: true }) })
    services.github = shared
    // services.githubFor stays undefined — byte-for-byte today's behavior.
    const orch = new Orchestrator(services)

    const id = await verifiedSession(orch, 'owner-1')
    await orch.confirmPush(id)
    expect(shared.pushed).toBe(true)
  })

  // ── HONESTY: a real-mode owner with NO usable GitHub connection must NOT get a fake mock push ──
  it('REFUSES (NoGitHubDestinationError) instead of a silent mock-success when a real-mode owner has no connection', async () => {
    const store = new MockSessionStore()
    const mock = new MockGitHubAdapter() // the default-boot shared adapter (no env token configured)
    const services = buildServices({ store, skillsDir, mockCriticScore: 90, testRunner: createMockTestRunner({ testsRun: 2, passed: true }) })
    services.github = mock
    services.githubFor = (_ownerId: string) => undefined // REAL mode wired, but owner has no connection
    const orch = new Orchestrator(services)

    const id = await verifiedSession(orch, 'owner-1')
    await expect(orch.confirmPush(id)).rejects.toBeInstanceOf(NoGitHubDestinationError)
    // The mock was NOT silently pushed to (no fake github.com/mock/<id> success).
    expect(mock.read(id)).toEqual([])
    // Retryable, not a dead end: the session parks push_failed so a later (post-connect) confirm works.
    expect((await store.get(id))?.status).toBe('push_failed')
  })

  it('STILL allows the mock for an ANONYMOUS session (no ownerId) — demo/keyless path unchanged', async () => {
    const store = new MockSessionStore()
    const mock = new MockGitHubAdapter()
    const services = buildServices({ store, skillsDir, mockCriticScore: 90, testRunner: createMockTestRunner({ testsRun: 2, passed: true }) })
    services.github = mock
    services.githubFor = (_ownerId: string) => undefined // wired, but no ownerId on the session to key on
    const orch = new Orchestrator(services)

    const id = await verifiedSession(orch /* anonymous */)
    const done = await orch.confirmPush(id)
    expect(done.status).toBe('done')
    expect(mock.read(id).length).toBeGreaterThan(0) // the mock DID receive the push (no refusal)
  })

  it('STILL allows the mock when githubFor is ABSENT entirely (NODE_ENV=test / no connections store)', async () => {
    const store = new MockSessionStore()
    const mock = new MockGitHubAdapter()
    const services = buildServices({ store, skillsDir, mockCriticScore: 90, testRunner: createMockTestRunner({ testsRun: 2, passed: true }) })
    services.github = mock
    // services.githubFor stays undefined — NOT real-mode, so the mock is the legitimate destination.
    const orch = new Orchestrator(services)

    const id = await verifiedSession(orch, 'owner-1')
    const done = await orch.confirmPush(id)
    expect(done.status).toBe('done')
  })
})
