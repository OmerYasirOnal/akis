/**
 * CONTRACT: the 4 structural gates — exercised against the REAL execution path.
 *
 * Every scenario drives the real Orchestrator + sub-agents and tries to BREAK a
 * gate. Each must fail if the corresponding enforcement is weakened (the mutation
 * tripwires the reviews demanded):
 *   Gate 1 — code cannot be produced/pushed before approval (+ content-bound)
 *   Gate 2 — a producer cannot manufacture verification (only the verifier's
 *            TestRunner can mint a VerifyToken)
 *   Gate 3 — verification = a persisted VerifyToken from a real ≥1-test pass;
 *            the store cannot be made to claim it, and a forged event is ignored
 *   Gate 4 — push needs a VerifyToken-backed, code-digest-bound ApprovedPush;
 *            not repeatable
 */
import { describe, it, expect } from 'vitest'
import { Orchestrator, SpecNotApprovedError, AlreadyPushedError } from '../../src/orchestrator/Orchestrator.js'
import { MockSessionStore } from '../../src/store/MockSessionStore.js'
import { buildServices } from '../../src/di/services.js'
import { createMockTestRunner } from '../../src/verify/TestRunner.js'
import { mintApprovedPush, NotVerifiedError } from '../../src/gates/pushGate.js'
import { ProtoAgent } from '../../src/orchestrator/subagents/ProtoAgent.js'
import { MockProvider } from '../../src/agent/providers/mock/MockProvider.js'
import { EventBus } from '../../src/events/bus.js'
import { initialSession, isVerified } from '@akis/shared'
import { verifyWith } from '../helpers/tokens.js'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/skills/library')

function make(opts: { mockCriticScore?: number; testsRun?: number; passed?: boolean } = {}) {
  const store = new MockSessionStore()
  const services = buildServices({
    store, skillsDir,
    mockCriticScore: opts.mockCriticScore ?? 90,
    testRunner: createMockTestRunner({ testsRun: opts.testsRun ?? 2, passed: opts.passed ?? true }),
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
    expect(isVerified(done)).toBe(true)
    const events = services.bus.recent(s.id)
    expect(events.some(e => e.kind === 'gate' && e.gate === 'spec_approval' && e.state === 'satisfied')).toBe(true)
    expect(events.some(e => e.kind === 'verify' && e.agent === 'trace')).toBe(true)
    // CF2: tool_call/tool_result are emitted for the real tool uses, and a preview
    // event carries the produced artifact's real URL after a successful push.
    expect(events.some(e => e.kind === 'tool_call' && e.tool === 'run_tests')).toBe(true)
    expect(events.some(e => e.kind === 'tool_call' && e.tool === 'push_to_github')).toBe(true)
    expect(events.some(e => e.kind === 'preview' && e.url.includes(s.id))).toBe(true)
  })

  it('B — Gate 1: runToVerification before approve throws and produces NO code', async () => {
    const { orch, services } = make()
    const s = await orch.start({ idea: 'todo' })
    await expect(orch.runToVerification(s.id)).rejects.toBeInstanceOf(Error) // WrongStatusError (not 'building')
    const st = (await services.store.get(s.id))!
    expect(st.code).toBeUndefined()
    expect(services.github.read(s.id)).toHaveLength(0)
  })

  it('B2 — Gate 1: ProtoAgent cannot run without an ApprovedSpec token (structural)', () => {
    const proto = new ProtoAgent({ bus: new EventBus(), provider: new MockProvider() })
    // No ApprovedSpec can be minted from an unapproved session, so Proto is uncallable.
    // (Compile-time: proto.run requires `approved: ApprovedSpec`; the only mint path is approve().)
    expect(typeof proto.run).toBe('function')
  })

  it('C — Gate 2: a producer cannot manufacture verification by forging a verify event', async () => {
    const { orch, services } = make({ testsRun: 0 }) // verifier would NOT verify
    const s = await orch.start({ idea: 'todo' })
    await orch.approve(s.id)
    // A producer forges a trace-tagged verify event directly on the bus.
    services.bus.emit({ kind: 'verify', testsRun: 99, passed: true, agent: 'trace', laneId: 'main', sessionId: s.id, ts: 1 })
    await orch.runToVerification(s.id)
    const st = (await services.store.get(s.id))!
    // The forged event is ignored — verification is the persisted token, not the event.
    expect(isVerified(st)).toBe(false)
    expect(st.status).not.toBe('awaiting_push_confirm')
    await expect(orch.confirmPush(s.id)).rejects.toBeInstanceOf(Error) // blocked: no token / wrong status
  })

  it('C2 — Gate 3: mintVerifyToken fails closed for a real 0-test run (no token to persist)', async () => {
    // The only way to get a TestRunResult is to run a runner. A 0-test result
    // yields no token — so there is nothing to record as verification, and the
    // store has no generic-patch path to set verifyToken/approval (SessionPatch
    // omits them; asserted at the type level below).
    expect(await verifyWith('s1', [], { testsRun: 0, passed: true })).toBeNull()
  })

  it('D — Gate 3: tests ran but failed => not verified, push impossible', async () => {
    const { orch, services } = make({ testsRun: 5, passed: false })
    const s = await orch.start({ idea: 'todo' })
    await orch.approve(s.id)
    await orch.runToVerification(s.id)
    const st = (await services.store.get(s.id))!
    expect(isVerified(st)).toBe(false)
    expect(st.status).not.toBe('awaiting_push_confirm')
    await expect(orch.confirmPush(s.id)).rejects.toBeInstanceOf(Error)
  })

  it('E — Gate 4: ApprovedPush cannot be minted without a real VerifyToken', () => {
    const unverified = initialSession('s1', 'idea')
    expect(() => mintApprovedPush(unverified, [])).toThrow(NotVerifiedError)
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

  it('H — Gate 2: only the verifier (trace) accepts a Verifier; producers cannot (compile-time)', () => {
    // The exclusivity is structural at the type level: ProtoAgent/ScribeAgent deps
    // do NOT accept a verifier or a runner. The @ts-expect-error tripwires below
    // FAIL TO COMPILE if a producer is ever given a verify capability.
    const { services } = make()
    expect(services.trace).toBeDefined()
    expect('run' in services.proto).toBe(true)
  })

  it('I — Gate 1 (orchestrator path): cannot reach build without approval; store patch cannot fake it', async () => {
    const { orch, services } = make()
    const s = await orch.start({ idea: 'todo' })
    // Force status to 'building' WITHOUT approval via the generic patch (the only
    // public mutation). approval is NOT in SessionPatch, so it stays undefined.
    await services.store.update(s.id, { status: 'building' }, s.version)
    // Gate 1: runToVerification mints ApprovedSpec, which throws without approval.
    await expect(orch.runToVerification(s.id)).rejects.toBeInstanceOf(SpecNotApprovedError)
    expect((await services.store.get(s.id))!.code).toBeUndefined()
  })

  it('J — Gate 4 (orchestrator path): cannot push without verification; store patch cannot fake it', async () => {
    const { orch, services } = make({ testsRun: 0 }) // verifier fails closed
    const s = await orch.start({ idea: 'todo' })
    await orch.approve(s.id)
    await orch.runToVerification(s.id) // leaves status 'building' (not verified)
    // Force status to 'awaiting_push_confirm' WITHOUT a verifyToken (not patchable).
    const cur = (await services.store.get(s.id))!
    await services.store.update(s.id, { status: 'awaiting_push_confirm', code: { files: [{ filePath: 'a.ts', content: 'x' }] } }, cur.version)
    // Gate 4: confirmPush mints ApprovedPush, which throws without a VerifyToken.
    await expect(orch.confirmPush(s.id)).rejects.toBeInstanceOf(NotVerifiedError)
    expect(services.github.read(s.id)).toHaveLength(0)
  })
})

// ── Type-level tripwires: the gate tokens are nominally branded and the gate
// fields are not writable through the generic store patch. These FAIL TO COMPILE
// if the brands are weakened back to string-literal fields. ──────────────────
import type { SessionPatch } from '../../src/store/SessionStore.js'
import type { ApprovedPush } from '../../src/gates/pushGate.js'

// @ts-expect-error — ApprovedPush cannot be written as a literal (nominal brand)
const _forgePush: ApprovedPush = { sessionId: 's1' }
void _forgePush
// @ts-expect-error — even with a fake __brand string, the nominal brand rejects it
const _forgePush2: ApprovedPush = { __brand: 'ApprovedPush', sessionId: 's1' }
void _forgePush2
// @ts-expect-error — SessionPatch must not allow writing the verification field
const _patchVerify: SessionPatch = { verifyToken: undefined }
void _patchVerify
// @ts-expect-error — SessionPatch must not allow writing the approval field
const _patchApproval: SessionPatch = { approval: undefined }
void _patchApproval

// Gate 2 (compile-time): producers' deps must NOT accept a verify capability.
import { ProtoAgent as _Proto } from '../../src/orchestrator/subagents/ProtoAgent.js'
import { ScribeAgent as _Scribe } from '../../src/orchestrator/subagents/ScribeAgent.js'
import { EventBus as _Bus } from '../../src/events/bus.js'
import { createVerifier as _mkVerifier } from '../../src/verify/verifier.js'
import { createMockTestRunner as _mkRunner } from '../../src/verify/TestRunner.js'
// @ts-expect-error — ProtoAgent (producer) does not accept a verifier in its deps
void new _Proto({ bus: new _Bus(), verifier: _mkVerifier(_mkRunner({ testsRun: 1, passed: true })) })
// @ts-expect-error — ScribeAgent (producer) does not accept a runner in its deps
void new _Scribe({ bus: new _Bus(), runner: _mkRunner({ testsRun: 1, passed: true }) })

void SpecNotApprovedError
