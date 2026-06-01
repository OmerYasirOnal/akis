/**
 * CONTRACT: the 4 structural gates.
 *
 * This is the regression tripwire for sub-project #1. It asserts the 4 gates
 * STRUCTURALLY, regardless of the agent's flow:
 *   Gate 1 — no code-write (dispatch_proto) before spec approval
 *   Gate 2 — only the verifier (trace) may run_tests (producer ≠ verifier)
 *   Gate 3 — "verified" requires a real ≥1-test pass (no vacuous green)
 *   Gate 4 — push needs an ApprovedPush token, mintable only when verified
 *
 * Any later change that lets a gate be bypassed turns this red.
 */
import { describe, it, expect } from 'vitest'
import { Orchestrator } from '../../src/orchestrator/Orchestrator.js'
import { MockProvider } from '../../src/agent/mock/MockProvider.js'
import { MockSessionStore } from '../../src/store/MockSessionStore.js'
import { buildServices } from '../../src/di/services.js'
import { canUseTool } from '../../src/tools/permission.js'
import { mintApprovedPush, NotVerifiedError } from '../../src/gates/pushGate.js'
import { initialSession } from '@akis/shared'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/skills/library')

function make(knobs: Record<string, unknown> = {}) {
  const provider = new MockProvider({ script: [{ text: 'ok' }], knobs: { mockCriticScore: 90, mockTraceTestCount: 2, ...knobs } })
  const services = buildServices({ provider, store: new MockSessionStore(), skillsDir })
  return { services, orch: new Orchestrator(services) }
}

describe('CONTRACT: 4 structural gates', () => {
  it('A — happy path reaches done with verified=true; ApprovedPush only after confirm', async () => {
    const { orch, services } = make()
    const s = await orch.start({ idea: 'todo web app' })
    await orch.approve(s.id)
    await orch.runToVerification(s.id)
    const done = await orch.confirmPush(s.id)
    expect(done.status).toBe('done')
    expect(done.verified).toBe(true)
    const events = services.bus.recent(s.id)
    expect(events.some(e => e.kind === 'gate' && e.gate === 'spec_approval' && e.state === 'satisfied')).toBe(true)
    expect(events.some(e => e.kind === 'gate' && e.gate === 'push_confirm')).toBe(true)
  })

  it('B — Gate 1: dispatch_proto denied before spec approval', () => {
    const base = initialSession('s1', 'idea')
    expect(canUseTool('orchestrator', 'dispatch_proto', base).ok).toBe(false)
    expect(canUseTool('orchestrator', 'dispatch_proto', { ...base, approvedSpec: { title: 't', body: 'b' } }).ok).toBe(true)
  })

  it('C — Gate 2: only the verifier (trace) may run_tests', () => {
    const base = initialSession('s1', 'idea')
    expect(canUseTool('trace', 'run_tests', base).ok).toBe(true)
    for (const r of ['orchestrator', 'proto', 'scribe', 'critic'] as const) {
      expect(canUseTool(r, 'run_tests', base).ok).toBe(false)
    }
  })

  it('D — Gate 3: vacuous green (0 tests) never verifies, cannot mint, never done', async () => {
    const { orch, services } = make({ mockTraceTestCount: 0 })
    const s = await orch.start({ idea: 'todo' })
    await orch.approve(s.id)
    await orch.runToVerification(s.id)
    const st = (await services.store.get(s.id))!
    expect(st.verified).toBe(false)
    expect(() => mintApprovedPush(st)).toThrow(NotVerifiedError)
    await expect(orch.confirmPush(s.id)).rejects.toBeInstanceOf(NotVerifiedError)
    expect((await services.store.get(s.id))!.status).not.toBe('done')
  })

  it('E — Gate 4: minting needs verified', () => {
    const verified = { ...initialSession('s1', 'idea'), verified: true }
    expect(() => mintApprovedPush(verified)).not.toThrow()
    expect(() => mintApprovedPush({ ...verified, verified: false })).toThrow(NotVerifiedError)
  })

  it('F — liveness: events are agent+lane tagged; the verify event is verifier-tagged', async () => {
    const { orch, services } = make()
    const s = await orch.start({ idea: 'todo' })
    await orch.approve(s.id)
    await orch.runToVerification(s.id)
    const events = services.bus.recent(s.id)
    expect(events.length).toBeGreaterThan(0)
    expect(events.every(e => typeof e.agent === 'string' && typeof e.laneId === 'string')).toBe(true)
    expect(events.some(e => e.kind === 'verify' && e.agent === 'trace')).toBe(true)
    // Trace ran on its own lane, distinct from the orchestrator's main lane.
    expect(new Set(events.map(e => e.laneId)).size).toBeGreaterThanOrEqual(2)
  })
})
