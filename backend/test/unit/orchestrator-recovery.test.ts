/**
 * RUN-STATE RECOVERY: the two backend dead-ends are now recoverable, WITHOUT
 * weakening any of the 4 structural gates.
 *
 *  1) awaiting_critic_resolution → resolveCritic('proceed' | 'abandon')
 *       - proceed: accepts the AUTOMATIC critic's non-approval and CONTINUES the
 *         pipeline. CRITICAL — it never skips a STRUCTURAL gate:
 *           · parked at the SPEC step (no approval yet) → opens the human
 *             spec-approval gate (awaiting_spec_approval); the human still approves.
 *           · parked at the CODE step (spec already approved) → continues to the
 *             REAL verify + push-confirm gates (which STILL apply).
 *       - abandon: → cancelled.
 *  2) verify_failed → retryVerification()
 *       - re-enters the iterate loop and RE-RUNS REAL verification; mint still
 *         needs a genuine ≥1-test pass (no bypass); bounded by the iterate budget.
 */
import { describe, it, expect } from 'vitest'
import { Orchestrator, WrongStatusError } from '../../src/orchestrator/Orchestrator.js'
import { MockSessionStore } from '../../src/store/MockSessionStore.js'
import { buildServices } from '../../src/di/services.js'
import { createMockTestRunner } from '../../src/verify/TestRunner.js'
import type { CriticResult } from '../../src/orchestrator/subagents/critic/CriticAgent.js'
import { isVerified } from '@akis/shared'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/skills/library')

function makeOrch(opts: { mockCriticScore?: number; testsRun?: number; passed?: boolean; requireCriticResolution?: boolean } = {}) {
  const store = new MockSessionStore()
  const services = buildServices({
    store, skillsDir,
    mockCriticScore: opts.mockCriticScore ?? 90,
    testRunner: createMockTestRunner({ testsRun: opts.testsRun ?? 2, passed: opts.passed ?? true }),
    ...(opts.requireCriticResolution ? { gatePolicy: { requireCriticResolution: true } } : {}),
  })
  return { orch: new Orchestrator(services), services }
}

/** A critic stub that approves the spec but NOT the code (no critical), so the run
 *  parks at awaiting_critic_resolution at the CODE step with an approval token present. */
function review(approved: boolean, critical = false): CriticResult {
  return {
    type: 'review',
    data: {
      approved, overallScore: approved ? 90 : 65, summary: 'stub', findings: [],
      reviewType: 'code_review', iteration: 1, hasCriticalFinding: critical, maxSeverity: critical ? 'critical' : 'info',
    },
  }
}
function makeCodeStepOrch(opts: { testsRun?: number; passed?: boolean } = {}) {
  const store = new MockSessionStore()
  const services = buildServices({
    store, skillsDir, mockCriticScore: 90,
    testRunner: createMockTestRunner({ testsRun: opts.testsRun ?? 2, passed: opts.passed ?? true }),
    gatePolicy: { requireCriticResolution: true },
  })
  // Spec approved (real mock critic, score 90); code review NOT approved → parks at the code step.
  // Override only reviewCode on the real CriticAgent instance (keeps its other members intact).
  services.critic.reviewCode = async (): Promise<CriticResult> => review(false)
  return { orch: new Orchestrator(services), services }
}

describe('Recovery — critic-resolution is actionable + resolvable', () => {
  it('parks at awaiting_critic_resolution and emits a structured recovery(awaiting) signal', async () => {
    const { orch, services } = makeOrch({ mockCriticScore: 65 })
    const s = await orch.start({ idea: 'todo' })
    // The spec review at score 65 does not approve → start() parks at critic_resolution.
    expect((await services.store.get(s.id))!.status).toBe('awaiting_critic_resolution')
    const rec = services.bus.recent(s.id).find(e => e.kind === 'recovery' && e.recovery === 'critic_resolution')
    expect(rec).toBeDefined()
    expect(rec).toMatchObject({ kind: 'recovery', recovery: 'critic_resolution', state: 'awaiting' })
  })

  it('GATE-SAFETY: proceed from a SPEC-step park opens the structural spec gate (does NOT auto-build)', async () => {
    // Parked at the spec step → NO approval token. Proceed must NOT bypass Gate 1: it opens
    // awaiting_spec_approval so the human still satisfies the structural spec-approval gate.
    const { orch, services } = makeOrch({ mockCriticScore: 65 })
    const s = await orch.start({ idea: 'todo' })
    const after = await orch.resolveCritic(s.id, 'proceed')
    expect(after.status).toBe('awaiting_spec_approval')
    expect(after.approval).toBeUndefined() // Gate 1: still no approval token
    expect(after.code).toBeUndefined()     // no code produced — build did not run
    const events = services.bus.recent(s.id)
    expect(events.some(e => e.kind === 'recovery' && e.recovery === 'critic_resolution' && e.state === 'resolved')).toBe(true)
    expect(events.some(e => e.kind === 'gate' && e.gate === 'spec_approval' && e.state === 'awaiting')).toBe(true)
  })

  it('proceed from a CODE-step park continues to the REAL verify + push gates (verifier passes → awaiting_push_confirm)', async () => {
    const { orch, services } = makeCodeStepOrch({ testsRun: 2, passed: true })
    const s = await orch.start({ idea: 'todo' })
    await orch.approve(s.id) // structural spec gate satisfied
    const parked = await orch.runToVerification(s.id)
    expect(parked.status).toBe('awaiting_critic_resolution')
    expect(parked.code).toBeDefined() // code was produced + persisted at the code-step park
    const after = await orch.resolveCritic(s.id, 'proceed')
    expect(after.status).toBe('awaiting_push_confirm')
    expect(isVerified(after)).toBe(true)
    expect(services.bus.recent(s.id).some(e => e.kind === 'gate' && e.gate === 'push_confirm' && e.state === 'awaiting')).toBe(true)
  })

  it('GATE-SAFETY: proceed from a CODE-step park does NOT bypass verify — a fail-closed verifier cannot push', async () => {
    const { orch, services } = makeCodeStepOrch({ testsRun: 0, passed: true }) // verifier mints no token
    const s = await orch.start({ idea: 'todo' })
    await orch.approve(s.id)
    await orch.runToVerification(s.id)
    const after = await orch.resolveCritic(s.id, 'proceed')
    expect(isVerified(after)).toBe(false)
    expect(after.status).toBe('verify_failed')
    await expect(orch.confirmPush(s.id)).rejects.toBeInstanceOf(Error)
  })

  it('abandon → cancelled (terminal) and emits a recovery(resolved) signal', async () => {
    const { orch, services } = makeOrch({ mockCriticScore: 65 })
    const s = await orch.start({ idea: 'todo' })
    const after = await orch.resolveCritic(s.id, 'abandon')
    expect(after.status).toBe('cancelled')
    expect(services.bus.recent(s.id).some(e => e.kind === 'recovery' && e.recovery === 'critic_resolution' && e.state === 'resolved')).toBe(true)
  })

  it('resolveCritic refuses from a non-resolution status', async () => {
    const { orch } = makeOrch()
    const s = await orch.start({ idea: 'todo' }) // awaiting_spec_approval (good spec)
    await expect(orch.resolveCritic(s.id, 'proceed')).rejects.toBeInstanceOf(WrongStatusError)
  })
})

describe('Recovery — verify-fail is retryable, never a silent dead-end', () => {
  it('a failed real verify lands in verify_failed (not a silent reset to building) + recovery signal', async () => {
    const { orch, services } = makeOrch({ testsRun: 3, passed: false })
    const s = await orch.start({ idea: 'todo' })
    await orch.approve(s.id)
    const after = await orch.runToVerification(s.id)
    expect(after.status).toBe('verify_failed')
    expect(isVerified(after)).toBe(false)
    expect(services.bus.recent(s.id).some(e => e.kind === 'recovery' && e.recovery === 'verify_failed' && e.state === 'awaiting')).toBe(true)
  })

  it('retryVerification re-runs REAL verification; a now-passing verifier reaches awaiting_push_confirm', async () => {
    const store = new MockSessionStore()
    let passing = false
    // A runner whose pass outcome we flip between the first verify and the retry. It
    // delegates to the BRANDED mock runner, so a passing run still mints a real token.
    const services = buildServices({
      store, skillsDir, mockCriticScore: 90,
      testRunner: { run: (files, opts) => createMockTestRunner({ testsRun: passing ? 2 : 3, passed: passing }).run(files, opts) },
    })
    const orch = new Orchestrator(services)
    const s = await orch.start({ idea: 'todo' })
    await orch.approve(s.id)
    expect((await orch.runToVerification(s.id)).status).toBe('verify_failed')
    passing = true
    const after = await orch.retryVerification(s.id)
    expect(after.status).toBe('awaiting_push_confirm')
    expect(isVerified(after)).toBe(true)
  })

  it('GATE-SAFETY: a retry whose tests fail AGAIN stays unverified and cannot push', async () => {
    const { orch, services } = makeOrch({ testsRun: 3, passed: false })
    const s = await orch.start({ idea: 'todo' })
    await orch.approve(s.id)
    await orch.runToVerification(s.id)
    const after = await orch.retryVerification(s.id)
    expect(isVerified(after)).toBe(false)
    expect(after.status).toBe('verify_failed')
    await expect(orch.confirmPush(s.id)).rejects.toBeInstanceOf(Error)
  })

  it('retryVerification refuses from a non-verify_failed status', async () => {
    const { orch } = makeOrch()
    const s = await orch.start({ idea: 'todo' })
    await orch.approve(s.id) // status building, not verify_failed
    await expect(orch.retryVerification(s.id)).rejects.toBeInstanceOf(WrongStatusError)
  })
})
