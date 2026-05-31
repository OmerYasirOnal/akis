import { describe, it, expect } from 'vitest'
import { Orchestrator } from '../../src/orchestrator/Orchestrator.js'
import { MockProvider } from '../../src/agent/mock/MockProvider.js'
import { MockSessionStore } from '../../src/store/MockSessionStore.js'
import { buildServices } from '../../src/di/services.js'
import { NotVerifiedError } from '../../src/gates/pushGate.js'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/skills/library')

function makeOrch(knobs: Record<string, unknown> = {}) {
  const provider = new MockProvider({ script: [{ text: 'ok' }], knobs: { mockCriticScore: 90, mockTraceTestCount: 2, ...knobs } })
  const store = new MockSessionStore()
  const services = buildServices({ provider, store, skillsDir })
  return { orch: new Orchestrator(services), services }
}

describe('Orchestrator (happy path on mock)', () => {
  it('scribe→critic(spec)→[approve]→proto→validator→critic(code)→trace→[confirm]→done verified', async () => {
    const { orch, services } = makeOrch()
    const s = await orch.start({ idea: 'build a todo web app' })
    expect((await services.store.get(s.id))!.status).toBe('awaiting_spec_approval')

    await orch.approve(s.id)
    await orch.runToVerification(s.id)
    const afterTrace = (await services.store.get(s.id))!
    expect(afterTrace.verified).toBe(true)
    expect(afterTrace.status).toBe('awaiting_push_confirm')

    const done = await orch.confirmPush(s.id)
    expect(done.status).toBe('done')
    expect(done.verified).toBe(true)
  })
})

describe('Orchestrator (vacuous-green guard)', () => {
  it('0 tests → not verified → cannot confirm push', async () => {
    const { orch, services } = makeOrch({ mockTraceTestCount: 0 })
    const s = await orch.start({ idea: 'todo' })
    await orch.approve(s.id)
    await orch.runToVerification(s.id)
    const st = (await services.store.get(s.id))!
    expect(st.verified).toBe(false)
    expect(st.status).not.toBe('awaiting_push_confirm')
    await expect(orch.confirmPush(s.id)).rejects.toBeInstanceOf(NotVerifiedError)
    expect((await services.store.get(s.id))!.status).not.toBe('done')
  })
})

describe('Orchestrator (critic hard-block)', () => {
  it('critical code finding → awaiting_critic_resolution, never verified', async () => {
    const { orch, services } = makeOrch({ mockCriticScore: 40 })
    const s = await orch.start({ idea: 'todo' })
    await orch.approve(s.id)
    await orch.runToVerification(s.id)
    const st = (await services.store.get(s.id))!
    expect(st.status).toBe('awaiting_critic_resolution')
    expect(st.verified).toBe(false)
  })
})
