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
})
