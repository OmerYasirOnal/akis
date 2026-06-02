import { describe, it, expect, afterEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerSessionRoutes } from '../../src/api/sessions.routes.js'
import { buildServices } from '../../src/di/services.js'
import { Orchestrator } from '../../src/orchestrator/Orchestrator.js'
import { WorkflowStore } from '../../src/workflow/WorkflowStore.js'
import { MockSessionStore } from '../../src/store/MockSessionStore.js'
import { MockProvider } from '../../src/agent/providers/mock/MockProvider.js'
import { initialSession, type WorkflowConfig } from '@akis/shared'

const skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/skills/library')

let app: FastifyInstance | undefined
afterEach(async () => { await app?.close(); app = undefined })

async function build() {
  const store = new MockSessionStore()
  const services = buildServices({ store, skillsDir, provider: new MockProvider() })
  const base = new Orchestrator(services)
  const wfStore = new WorkflowStore()
  const saved = await wfStore.save({ name: 'fast', agents: [{ role: 'scribe', model: { providerId: 'anthropic', modelId: 'claude-opus-4-8' } }], iterateBudget: 1 })
  const calls = { wf: undefined as WorkflowConfig | undefined, started: false, approved: false }
  const spy = {
    async start({ idea }: { idea: string }) { calls.started = true; const s = initialSession('wf-sess', idea); await store.create(s); return s },
    async approve(id: string) { calls.approved = true; return (await store.get(id))! },
    async runToVerification(id: string) { return (await store.get(id))! },
    async confirmPush(id: string) { return (await store.get(id))! },
  } as unknown as Orchestrator
  const makeOrchestrator = (wf: WorkflowConfig): Orchestrator => { calls.wf = wf; return spy }
  const a = Fastify({ logger: false })
  registerSessionRoutes(a, { orchestrator: base, services, workflowStore: wfStore, makeOrchestrator })
  return { a, saved, calls }
}

describe('per-session workflow selection (F2-AC9/AC10)', () => {
  it('binds a saved workflow to the session and routes its actions to that orchestrator', async () => {
    const { a, saved, calls } = await build(); app = a
    const res = await a.inject({ method: 'POST', url: '/sessions', payload: { idea: 'todo', workflowId: saved.id } })
    expect(res.statusCode).toBe(201)
    expect(calls.started).toBe(true)
    expect(calls.wf?.id).toBe(saved.id)
    expect(calls.wf?.iterateBudget).toBe(1)
    // The bound orchestrator (not the default) handles this session's actions.
    await a.inject({ method: 'POST', url: '/sessions/wf-sess/approve' })
    expect(calls.approved).toBe(true)
  })

  it('unknown workflowId → 404', async () => {
    const { a } = await build(); app = a
    expect((await a.inject({ method: 'POST', url: '/sessions', payload: { idea: 'todo', workflowId: 'nope' } })).statusCode).toBe(404)
  })

  it('no workflowId → uses the default orchestrator (no binding)', async () => {
    const { a, calls } = await build(); app = a
    const res = await a.inject({ method: 'POST', url: '/sessions', payload: { idea: 'todo app' } })
    expect(res.statusCode).toBe(201)
    expect(calls.wf).toBeUndefined()
    expect(calls.started).toBe(false) // the spy (workflow orch) was never used
  })
})
