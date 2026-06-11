/**
 * RUN CONTROL: Orchestrator.cancel — a clean, terminal ABANDON of an in-flight run.
 *
 * Cancel is NOT a gate bypass. It sets the run to `cancelled` (an already-TERMINAL
 * status) from a NON-TERMINAL state, best-effort; it NEVER marks a run verified, never
 * mints a token, and never ships. A terminal run (done/failed/cancelled) refuses cancel
 * (WrongStatusError → 409 at the route), so it cannot be used to disturb a finished run.
 */
import { describe, it, expect } from 'vitest'
import { Orchestrator, WrongStatusError } from '../../src/orchestrator/Orchestrator.js'
import { MockSessionStore } from '../../src/store/MockSessionStore.js'
import { buildServices } from '../../src/di/services.js'
import { createMockTestRunner } from '../../src/verify/TestRunner.js'
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

describe('Run control — cancel is a clean terminal abandon (no gate bypass)', () => {
  it('cancel from an in-flight (awaiting_spec_approval) run → cancelled (terminal), NOT verified/shipped', async () => {
    const { orch, services } = makeOrch()
    const s = await orch.start({ idea: 'todo' }) // good spec → awaiting_spec_approval
    const after = await orch.cancel(s.id)
    expect(after.status).toBe('cancelled')
    expect(isVerified(after)).toBe(false)          // never verified
    expect(after.verifyToken).toBeUndefined()      // no token minted
    expect(services.github.read(s.id)).toHaveLength(0) // nothing pushed
    // A terminal `session` signal is emitted so the live view stops driving the run.
    expect(services.bus.recent(s.id).some(e => e.kind === 'session' && e.status === 'cancelled')).toBe(true)
  })

  it('cancel from building (mid-run) → cancelled, no code shipped', async () => {
    const { orch, services } = makeOrch()
    const s = await orch.start({ idea: 'todo' })
    await orch.approve(s.id) // status building
    const after = await orch.cancel(s.id)
    expect(after.status).toBe('cancelled')
    expect(services.github.read(s.id)).toHaveLength(0)
  })

  it('cancel from awaiting_push_confirm does NOT ship — it abandons a verified-but-unpushed run', async () => {
    const { orch, services } = makeOrch()
    const s = await orch.start({ idea: 'todo' })
    await orch.approve(s.id)
    const verified = await orch.runToVerification(s.id)
    expect(verified.status).toBe('awaiting_push_confirm')
    expect(isVerified(verified)).toBe(true)
    const after = await orch.cancel(s.id)
    expect(after.status).toBe('cancelled')
    // GATE 4 INTACT: cancel never pushes. The repo stays empty even though a token existed.
    expect(services.github.read(s.id)).toHaveLength(0)
  })

  it('cancel refuses from a terminal status (done) — WrongStatusError', async () => {
    const { orch } = makeOrch()
    const s = await orch.start({ idea: 'todo' })
    await orch.approve(s.id)
    await orch.runToVerification(s.id)
    const done = await orch.confirmPush(s.id)
    expect(done.status).toBe('done')
    await expect(orch.cancel(s.id)).rejects.toBeInstanceOf(WrongStatusError)
  })

  it('cancel is not repeatable — a second cancel refuses (already cancelled = terminal)', async () => {
    const { orch } = makeOrch()
    const s = await orch.start({ idea: 'todo' })
    await orch.cancel(s.id)
    await expect(orch.cancel(s.id)).rejects.toBeInstanceOf(WrongStatusError)
  })

  it('cancel of an unknown session throws not-found', async () => {
    const { orch } = makeOrch()
    await expect(orch.cancel('nope')).rejects.toThrow(/not found/)
  })

  // ── A4 — RETRYABLE PARKS ARE CANCEL-IMMUNE. push_failed/verify_failed are parked-but-
  //    retryable: confirmPush accepts a push_failed retry and retryVerification re-runs a failed
  //    verify. A blind cancel (e.g. the FE's 'New build' firing against a stale status snapshot)
  //    used to overwrite them with terminal 'cancelled', destroying the retry. They join the
  //    cancel-immune set; the gate-park statuses (awaiting_push_confirm / awaiting_critic_
  //    resolution) STAY cancellable — the live-gate abandon tests above must hold untouched. ──
  it('A4: cancel REFUSES a push_failed park (WrongStatusError) and the retry still ships afterwards', async () => {
    const { orch, services } = makeOrch()
    const s = await orch.start({ idea: 'todo' })
    await orch.approve(s.id)
    await orch.runToVerification(s.id) // → awaiting_push_confirm (verified)
    const original = services.github.createRepo.bind(services.github)
    let fail = true
    services.github.createRepo = async (id: string) => { if (fail) throw new Error('transient'); return original(id) }
    await expect(orch.confirmPush(s.id)).rejects.toThrow(/transient/) // → push_failed (retryable park)
    expect((await services.store.get(s.id))!.status).toBe('push_failed')

    // The blind cancel must NOT destroy the park…
    await expect(orch.cancel(s.id)).rejects.toBeInstanceOf(WrongStatusError)
    expect((await services.store.get(s.id))!.status).toBe('push_failed') // …status untouched

    // …and the retryability SURVIVED: a later gated confirmPush retry ships.
    fail = false
    const done = await orch.confirmPush(s.id)
    expect(done.status).toBe('done')
    expect(services.github.read(s.id).length).toBeGreaterThan(0)
  })

  it('A4: cancel REFUSES a verify_failed park (WrongStatusError) and the verify retry still works', async () => {
    const store = new MockSessionStore()
    let passing = false
    // A runner whose outcome flips between the first verify and the retry (recovery-test pattern):
    // a passing retry still mints a REAL branded token — retryability must survive the cancel attempt.
    const services = buildServices({
      store, skillsDir, mockCriticScore: 90,
      testRunner: { run: (files, opts) => createMockTestRunner({ testsRun: passing ? 2 : 3, passed: passing }).run(files, opts) },
    })
    const orch = new Orchestrator(services)
    const s = await orch.start({ idea: 'todo' })
    await orch.approve(s.id)
    expect((await orch.runToVerification(s.id)).status).toBe('verify_failed')

    await expect(orch.cancel(s.id)).rejects.toBeInstanceOf(WrongStatusError)
    expect((await services.store.get(s.id))!.status).toBe('verify_failed') // the park survived

    passing = true
    const after = await orch.retryVerification(s.id) // the retry path is intact
    expect(after.status).toBe('awaiting_push_confirm')
    expect(isVerified(after)).toBe(true)
  })
})
