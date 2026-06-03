/**
 * CONTRACT: structured test evidence is PERSISTED + SURFACED (additive, non-gate).
 *
 * The verifier already computes rich per-scenario BDD/E2E detail and (before this
 * track) discarded it. This pins that:
 *   1. after a VERIFIED run the session carries structured `testEvidence`
 *      (scenarios + counts + durationMs);
 *   2. after a FAILED run it carries the structured FAILURE report (named failing
 *      scenarios + bounded reasons), NOT free-form prose;
 *   3. the evidence is written on the NORMAL (non-gate) update path — the gate-field
 *      allowlist is NOT widened, and the VerifyToken / mint are unchanged;
 *   4. evidence NEVER affects minting (a real ≥1-test pass is still required).
 */
import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { Orchestrator } from '../../src/orchestrator/Orchestrator.js'
import { MockSessionStore } from '../../src/store/MockSessionStore.js'
import { buildServices } from '../../src/di/services.js'
import { createMockTestRunner } from '../../src/verify/TestRunner.js'
import { resolveVerifier } from '../../src/verify/verifier.js'
import { TraceAgent } from '../../src/orchestrator/subagents/TraceAgent.js'
import { EventBus } from '../../src/events/bus.js'
import { isVerified } from '@akis/shared'
import type { TestEvidence } from '@akis/shared'

const skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/skills/library')

function make(opts: { testsRun?: number; passed?: boolean } = {}) {
  const store = new MockSessionStore()
  const services = buildServices({
    store, skillsDir, mockCriticScore: 90,
    testRunner: createMockTestRunner({ testsRun: opts.testsRun ?? 2, passed: opts.passed ?? true }),
  })
  return { services, orch: new Orchestrator(services) }
}

describe('CONTRACT: persisted test evidence (additive, non-gate)', () => {
  it('after a VERIFIED run, GET session carries structured testEvidence (scenarios + counts + durationMs)', async () => {
    const { orch, services } = make({ testsRun: 3, passed: true })
    const s = await orch.start({ idea: 'todo web app' })
    await orch.approve(s.id)
    await orch.runToVerification(s.id)

    const st = (await services.store.get(s.id))!
    // The gate truth is intact AND independent of the evidence.
    expect(isVerified(st)).toBe(true)
    expect(st.status).toBe('awaiting_push_confirm')

    const ev = st.testEvidence as TestEvidence
    expect(ev).toBeDefined()
    expect(ev.passed).toBe(true)
    expect(ev.testsRun).toBe(3)
    expect(typeof ev.durationMs).toBe('number')
    expect(ev.scenarios.length).toBe(3)
    expect(ev.scenarios.every(x => x.passed)).toBe(true)
    // A passing run has NO structured failure report.
    expect(ev.failure).toBeUndefined()
  })

  it('after a FAILED run, GET session carries the STRUCTURED failure report (named scenarios + bounded reasons, no prose)', async () => {
    const { orch, services } = make({ testsRun: 4, passed: false })
    const s = await orch.start({ idea: 'todo' })
    await orch.approve(s.id)
    await orch.runToVerification(s.id)

    const st = (await services.store.get(s.id))!
    // Tests ran but failed ⇒ NOT verified, push impossible (gate unchanged).
    expect(isVerified(st)).toBe(false)
    expect(st.status).not.toBe('awaiting_push_confirm')

    const ev = st.testEvidence as TestEvidence
    expect(ev).toBeDefined()
    expect(ev.passed).toBe(false)
    expect(ev.failure).toBeDefined()
    expect(ev.failure!.failedCount).toBe(4)
    expect(ev.failure!.scenarios.length).toBe(4)
    // STRUCTURED ONLY: every failure carries a bounded reason and a named scenario,
    // never a free-form prose field.
    for (const sc of ev.failure!.scenarios) {
      expect(typeof sc.name).toBe('string')
      expect(sc.passed).toBe(false)
      expect(typeof sc.reason).toBe('string')
      expect(sc.reason!.length).toBeLessThan(80) // bounded label, not narrative
    }
  })

  it('evidence is OBSERVABILITY ONLY: a 0-test run mints NO token (evidence never affects minting)', async () => {
    const { orch, services } = make({ testsRun: 0, passed: true })
    const s = await orch.start({ idea: 'todo' })
    await orch.approve(s.id)
    await orch.runToVerification(s.id)
    const st = (await services.store.get(s.id))!
    // Fail-closed: no token despite passed:true, because testsRun < 1.
    expect(isVerified(st)).toBe(false)
    // Evidence is still present (it reflects the 0-test run) but cannot grant verification.
    expect(st.testEvidence).toBeDefined()
    expect(st.testEvidence!.testsRun).toBe(0)
  })

  it('testEvidence round-trips on the NORMAL patch without setting any gate field (Pg allowlist enforcement: pg-session-store.test.ts)', async () => {
    // MockSessionStore round-trip: writing testEvidence via the generic update never sets a gate
    // token. The REAL gate-write allowlist rejection (a forged approval/verifyToken in the patch is
    // dropped before SQL) is enforced + asserted on PgSessionStore in backend/test/unit/pg-session-store.test.ts.
    const store = new MockSessionStore()
    const evidence: TestEvidence = {
      testsRun: 1, passed: true, durationMs: 0,
      bdd: { built: 1, run: 1, passed: 1, failed: 0, skipped: 0, durationMs: 0 },
      e2e: { testsRun: 0, passed: false, expected: 0, unexpected: 0, flaky: 0, skipped: 0, durationMs: 0 },
      scenarios: [{ name: 'x', suite: 'bdd', passed: true }],
    }
    await store.create({ id: 's1', status: 'building', idea: 'i', version: 0 })
    const next = await store.update('s1', { testEvidence: evidence }, 0)
    expect(next.testEvidence).toEqual(evidence)
    expect(isVerified(next)).toBe(false) // no verifyToken was set
    expect(next.approval).toBeUndefined()
  })

  it('TraceAgent returns the gate token UNCHANGED plus additive evidence; the verify event is byte-identical', async () => {
    const bus = new EventBus()
    const trace = new TraceAgent({ bus, verifier: resolveVerifier({ kind: 'mock', cfg: { testsRun: 2, passed: true } }) })
    const { token, evidence } = await trace.run({ sessionId: 's1', laneId: 'verify', files: [{ filePath: 'a.ts', content: 'x' }] })
    expect(token).not.toBeNull()
    expect(token!.testsRun).toBe(2) // gate truth unchanged
    expect(evidence).toBeDefined()
    expect(evidence!.scenarios.length).toBe(2)
  })
})
