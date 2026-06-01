import { describe, it, expect } from 'vitest'
import { Orchestrator, AlreadyPushedError } from '../../src/orchestrator/Orchestrator.js'
import { MockSessionStore } from '../../src/store/MockSessionStore.js'
import { buildServices } from '../../src/di/services.js'
import { createMockTestRunner } from '../../src/verify/TestRunner.js'
import { NotVerifiedError } from '../../src/gates/pushGate.js'
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

void NotVerifiedError
