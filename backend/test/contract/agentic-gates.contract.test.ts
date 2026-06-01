/**
 * CONTRACT: the 4 structural gates — exercised against the REAL execution path.
 *
 * Unlike a helper-in-isolation test, every scenario drives the real Orchestrator
 * + sub-agents and tries to BREAK a gate. Each must fail if the corresponding
 * enforcement is weakened (these are the mutation tripwires the first review
 * found missing):
 *   Gate 1 — code cannot be produced/pushed before approval
 *   Gate 2 — a producer cannot manufacture verification (only the verifier's
 *            TestRunner can mint a VerifyToken)
 *   Gate 3 — verified requires a real >=1-test pass (0 tests or failing => not verified)
 *   Gate 4 — push requires a VerifyToken-backed ApprovedPush; not repeatable
 */
import { describe, it, expect } from 'vitest'
import { Orchestrator, SpecNotApprovedError, AlreadyPushedError } from '../../src/orchestrator/Orchestrator.js'
import { MockSessionStore } from '../../src/store/MockSessionStore.js'
import { buildServices } from '../../src/di/services.js'
import { MockTestRunner } from '../../src/verify/TestRunner.js'
import { mintVerifyToken } from '../../src/verify/VerifyToken.js'
import { mintApprovedPush, NotVerifiedError } from '../../src/gates/pushGate.js'
import { initialSession } from '@akis/shared'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/skills/library')

function make(opts: { mockCriticScore?: number; testsRun?: number; passed?: boolean } = {}) {
  const store = new MockSessionStore()
  const services = buildServices({
    store, skillsDir,
    mockCriticScore: opts.mockCriticScore ?? 90,
    testRunner: new MockTestRunner({ testsRun: opts.testsRun ?? 2, passed: opts.passed ?? true }),
  })
  return { services, orch: new Orchestrator(services) }
}

describe('CONTRACT: 4 structural gates (real path)', () => {
  it('A — happy path reaches done/verified through the real orchestrator', async () => {
    const { orch, services } = make()
    const s = await orch.start({ idea: 'todo web app' })
    await orch.approve(s.id)
    await orch.runToVerification(s.id)
    const done = await orch.confirmPush(s.id)
    expect(done.status).toBe('done')
    expect(done.verified).toBe(true)
    const events = services.bus.recent(s.id)
    expect(events.some(e => e.kind === 'gate' && e.gate === 'spec_approval' && e.state === 'satisfied')).toBe(true)
    expect(events.some(e => e.kind === 'verify' && e.agent === 'trace')).toBe(true)
  })

  it('B — Gate 1: runToVerification before approve throws and produces NO code', async () => {
    const { orch, services } = make()
    const s = await orch.start({ idea: 'todo' })
    await expect(orch.runToVerification(s.id)).rejects.toBeInstanceOf(SpecNotApprovedError)
    const st = (await services.store.get(s.id))!
    expect(st.code).toBeUndefined()
    expect(services.github.read(s.id)).toHaveLength(0)
  })

  it('C — Gate 2: a producer cannot manufacture verification by spoofing a verify event', async () => {
    const { orch, services } = make({ testsRun: 0 }) // verifier would NOT verify
    const s = await orch.start({ idea: 'todo' })
    await orch.approve(s.id)
    // A producer forges a trace-tagged verify event directly on the bus.
    services.bus.emit({ kind: 'verify', testsRun: 99, passed: true, agent: 'trace', laneId: 'main', sessionId: s.id, ts: 1 })
    await orch.runToVerification(s.id)
    const st = (await services.store.get(s.id))!
    // The forged event is ignored — verified comes from the VerifyToken, not the event.
    expect(st.verified).toBe(false)
    await expect(orch.confirmPush(s.id)).rejects.toBeInstanceOf(Error)
  })

  it('D — Gate 3: tests ran but failed => not verified, push impossible', async () => {
    const { orch, services } = make({ testsRun: 5, passed: false })
    const s = await orch.start({ idea: 'todo' })
    await orch.approve(s.id)
    await orch.runToVerification(s.id)
    const st = (await services.store.get(s.id))!
    expect(st.verified).toBe(false)
    expect(st.status).not.toBe('awaiting_push_confirm')
    await expect(orch.confirmPush(s.id)).rejects.toBeInstanceOf(Error)
  })

  it('E — Gate 4: ApprovedPush cannot be minted without a real VerifyToken', () => {
    expect(() => mintApprovedPush('s1', null)).toThrow(NotVerifiedError)
    // Even a hand-built "result" can't help: mintVerifyToken fails closed on 0 tests.
    const noToken = mintVerifyToken('s1', { __brand: 'TestRunResult', testsRun: 0, passed: true })
    expect(noToken).toBeNull()
    expect(() => mintApprovedPush('s1', noToken)).toThrow(NotVerifiedError)
  })

  it('F — Gate 4: confirmPush is not repeatable (no duplicate push)', async () => {
    const { orch, services } = make()
    const s = await orch.start({ idea: 'todo' })
    await orch.approve(s.id)
    await orch.runToVerification(s.id)
    await orch.confirmPush(s.id)
    const n = services.github.read(s.id).length
    await expect(orch.confirmPush(s.id)).rejects.toBeInstanceOf(AlreadyPushedError)
    expect(services.github.read(s.id).length).toBe(n)
  })

  it('G — liveness: events are agent+lane tagged; verify runs on its own lane', async () => {
    const { orch, services } = make()
    const s = await orch.start({ idea: 'todo' })
    await orch.approve(s.id)
    await orch.runToVerification(s.id)
    const events = services.bus.recent(s.id)
    expect(events.every(e => typeof e.agent === 'string' && typeof e.laneId === 'string')).toBe(true)
    expect(new Set(events.map(e => e.laneId)).size).toBeGreaterThanOrEqual(2)
  })
})

// Suppress unused import lint where initialSession may be handy for future cases.
void initialSession
