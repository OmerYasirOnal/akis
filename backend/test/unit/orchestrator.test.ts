import { describe, it, expect } from 'vitest'
import { Orchestrator, AlreadyPushedError } from '../../src/orchestrator/Orchestrator.js'
import { MockSessionStore } from '../../src/store/MockSessionStore.js'
import { buildServices } from '../../src/di/services.js'
import { createMockTestRunner } from '../../src/verify/TestRunner.js'
import { NotVerifiedError } from '../../src/gates/pushGate.js'
import { mintApprovedSpec } from '../../src/gates/specGate.js'
import type { RepoSource, RepoIngestInput } from '../../src/knowledge/ingest/RepoSource.js'
import { isVerified } from '@akis/shared'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/skills/library')

function makeOrch(opts: { mockCriticScore?: number; testsRun?: number; passed?: boolean } = {}) {
  const store = new MockSessionStore()
  const services = buildServices({
    store, skillsDir,
    mockCriticScore: opts.mockCriticScore ?? 90,
    testRunner: createMockTestRunner({ testsRun: opts.testsRun ?? 2, passed: opts.passed ?? true }),
  })
  return { orch: new Orchestrator(services), services }
}

describe('Orchestrator — happy path', () => {
  it('start→approve→verify→confirm reaches done/verified', async () => {
    const { orch, services } = makeOrch()
    const s = await orch.start({ idea: 'build a todo web app' })
    expect((await services.store.get(s.id))!.status).toBe('awaiting_spec_approval')
    await orch.approve(s.id)
    await orch.runToVerification(s.id)
    const afterTrace = (await services.store.get(s.id))!
    expect(isVerified(afterTrace)).toBe(true)
    expect(afterTrace.status).toBe('awaiting_push_confirm')
    const done = await orch.confirmPush(s.id)
    expect(done.status).toBe('done')
    expect(isVerified(done)).toBe(true)
  })
})

describe('Orchestrator — chat-approved spec seed (P0-1: single spec approval)', () => {
  it('a seed-started session opens already at building (spec-approved) with a minted ApprovedSpec and NO awaiting_spec_approval gate', async () => {
    const { orch, services } = makeOrch()
    const seed = { title: 'Minimal Todo', body: '# Minimal Todo\nAdd, list, complete todos.' }
    const s = await orch.start({ idea: seed.body, spec: seed })
    // The pipeline opens ALREADY at spec-approved (building), with NO second human click needed.
    expect(s.status).toBe('building')
    const stored = (await services.store.get(s.id))!
    expect(stored.status).toBe('building')
    // The seeded spec is AUTHORITATIVE (used as-is, not re-authored by Scribe).
    expect(stored.spec).toEqual(seed)
    // Gate 1 is genuinely satisfied: a real branded ApprovalToken is persisted (still minted
    // server-side via the approvalAuthority — never a literal).
    expect(stored.approval).toBeDefined()
    expect(mintApprovedSpec(stored).spec).toEqual(seed)
    // The gate event is SATISFIED, never a second 'awaiting' spec-approval gate.
    const gates = services.bus.recent(s.id).filter(e => e.kind === 'gate' && (e as { gate: string }).gate === 'spec_approval')
    expect(gates.some(e => (e as { state: string }).state === 'awaiting')).toBe(false)
    expect(gates.some(e => (e as { state: string }).state === 'satisfied')).toBe(true)
  })

  it('a seed-started session runs straight to verified+push without any approve() click (Proto reachable)', async () => {
    const { orch, services } = makeOrch()
    const seed = { title: 'Todo', body: '# Todo\nThe app.' }
    const s = await orch.start({ idea: seed.body, spec: seed })
    // No orch.approve() call — the chat-approved seed already satisfied Gate 1.
    await orch.runToVerification(s.id)
    const after = (await services.store.get(s.id))!
    expect(isVerified(after)).toBe(true)
    expect(after.status).toBe('awaiting_push_confirm')
    const done = await orch.confirmPush(s.id)
    expect(done.status).toBe('done')
  })

  it('an idea-only start is UNCHANGED: Scribe runs and the awaiting_spec_approval gate still emits', async () => {
    const { orch, services } = makeOrch()
    const s = await orch.start({ idea: 'build a todo web app' })
    // No seed → today's path: parked at the human spec gate, no approval minted yet.
    expect(s.status).toBe('awaiting_spec_approval')
    expect((await services.store.get(s.id))!.approval).toBeUndefined()
    const gates = services.bus.recent(s.id).filter(e => e.kind === 'gate' && (e as { gate: string }).gate === 'spec_approval')
    expect(gates.some(e => (e as { state: string }).state === 'awaiting')).toBe(true)
    expect(gates.some(e => (e as { state: string }).state === 'satisfied')).toBe(false)
  })
})

describe('Orchestrator — code-review visibility', () => {
  it('emits a structured code_review event (approved verdict) at the review step', async () => {
    const { orch, services } = makeOrch()
    const s = await orch.start({ idea: 'build a todo web app' })
    await orch.approve(s.id)
    await orch.runToVerification(s.id)
    const events = services.bus.recent(s.id)
    const cr = events.find(e => e.kind === 'code_review')
    expect(cr).toBeDefined()
    expect(cr).toMatchObject({ kind: 'code_review', approved: true, critical: false, agent: 'critic', laneId: 'main' })
    // Structured-only: findings/iteration are bounded numbers, never free-form prose.
    expect(typeof (cr as { findings: unknown }).findings).toBe('number')
    expect(typeof (cr as { iteration: unknown }).iteration).toBe('number')
    // It is NOT a text event, so the RAG ingestion sink never treats it as trusted grounding.
    expect(cr).not.toHaveProperty('text')
  })
})

describe('Orchestrator — vacuous green (0 tests)', () => {
  it('does not verify and cannot confirm push', async () => {
    const { orch, services } = makeOrch({ testsRun: 0 })
    const s = await orch.start({ idea: 'todo' })
    await orch.approve(s.id)
    await orch.runToVerification(s.id)
    const st = (await services.store.get(s.id))!
    expect(isVerified(st)).toBe(false)
    expect(st.status).not.toBe('awaiting_push_confirm')
    await expect(orch.confirmPush(s.id)).rejects.toBeInstanceOf(Error)
  })
})

describe('Orchestrator — tests ran but failed', () => {
  it('does not verify (passed=false with testsRun>=1)', async () => {
    const { orch, services } = makeOrch({ testsRun: 3, passed: false })
    const s = await orch.start({ idea: 'todo' })
    await orch.approve(s.id)
    await orch.runToVerification(s.id)
    expect(isVerified((await services.store.get(s.id))!)).toBe(false)
  })
})

describe('Orchestrator — critic hard-block', () => {
  it('critical finding → awaiting_critic_resolution, never verified', async () => {
    const { orch, services } = makeOrch({ mockCriticScore: 40 })
    const s = await orch.start({ idea: 'todo' })
    // start() already parks at awaiting_critic_resolution because the spec review failed.
    expect((await services.store.get(s.id))!.status).toBe('awaiting_critic_resolution')
    // approve is refused from that status.
    await expect(orch.approve(s.id)).rejects.toBeInstanceOf(Error)
    expect(isVerified((await services.store.get(s.id))!)).toBe(false)
  })
})

describe('Orchestrator — confirmPush is idempotent', () => {
  it('a second confirmPush throws and does not re-push', async () => {
    const { orch, services } = makeOrch()
    const s = await orch.start({ idea: 'todo' })
    await orch.approve(s.id)
    await orch.runToVerification(s.id)
    await orch.confirmPush(s.id)
    const filesAfterFirst = services.github.read(s.id).length
    await expect(orch.confirmPush(s.id)).rejects.toBeInstanceOf(AlreadyPushedError)
    expect(services.github.read(s.id).length).toBe(filesAfterFirst)
  })
})

describe('Orchestrator — verified survives a fresh instance (no in-memory token)', () => {
  it('a second Orchestrator over the same store can push the verified session', async () => {
    const store = new MockSessionStore()
    const services = buildServices({ store, skillsDir, mockCriticScore: 90, testRunner: createMockTestRunner({ testsRun: 2, passed: true }) })
    const orch1 = new Orchestrator(services)
    const s = await orch1.start({ idea: 'todo' })
    await orch1.approve(s.id)
    await orch1.runToVerification(s.id)
    // A different Orchestrator instance (simulating restart) sharing the store + github.
    const orch2 = new Orchestrator(services)
    const done = await orch2.confirmPush(s.id)
    expect(done.status).toBe('done')
    expect(isVerified(done)).toBe(true)
  })
})

describe('Orchestrator — repo auto-ingest on push (issue #7 AC1)', () => {
  // A repoSource + ragUserIdFor are present ONLY when RAG is on. Drive a verified
  // session to done and assert the push triggers an automatic ingest of the pushed repo.
  function makeRagOrch(repoSource: Pick<RepoSource, 'ingest'>) {
    const store = new MockSessionStore()
    const services = buildServices({
      store, skillsDir,
      mockCriticScore: 90,
      testRunner: createMockTestRunner({ testsRun: 2, passed: true }),
    })
    // Simulate RAG-on wiring: surface a repoSource + tenancy resolver on the services.
    const ragServices = {
      ...services,
      repoSource: repoSource as RepoSource,
      ragUserIdFor: (_sessionId: string) => 'local',
    }
    return { orch: new Orchestrator(ragServices), services: ragServices }
  }

  it('confirmPush triggers repoSource.ingest with {sessionId,userId} after a successful push', async () => {
    const calls: RepoIngestInput[] = []
    const repoSource = { ingest: async (input: RepoIngestInput): Promise<void> => { calls.push(input) } }
    const { orch } = makeRagOrch(repoSource)
    const s = await orch.start({ idea: 'todo' })
    await orch.approve(s.id)
    await orch.runToVerification(s.id)
    const done = await orch.confirmPush(s.id)
    expect(done.status).toBe('done')
    expect(calls).toEqual([{ sessionId: s.id, userId: 'local' }])
  })

  it('a THROWING repoSource.ingest does NOT fail confirmPush and the session still reaches done', async () => {
    let attempted = false
    const repoSource = { ingest: async (): Promise<void> => { attempted = true; throw new Error('ingest blew up') } }
    const { orch, services } = makeRagOrch(repoSource)
    const s = await orch.start({ idea: 'todo' })
    await orch.approve(s.id)
    await orch.runToVerification(s.id)
    const done = await orch.confirmPush(s.id)
    expect(attempted).toBe(true) // ingest WAS attempted (not vacuously skipped)
    expect(done.status).toBe('done')
    expect(isVerified(done)).toBe(true)
    // The session status persisted is still 'done' — the failed ingest never mutated it.
    expect((await services.store.get(s.id))!.status).toBe('done')
  })
})

void NotVerifiedError
