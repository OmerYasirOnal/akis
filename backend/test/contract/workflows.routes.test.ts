import { describe, it, expect, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerWorkflowRoutes } from '../../src/api/workflows.routes.js'
import { WorkflowStore } from '../../src/workflow/WorkflowStore.js'

let app: FastifyInstance | undefined
afterEach(async () => { await app?.close(); app = undefined })

function build() {
  const store = new WorkflowStore()
  const a = Fastify({ logger: false })
  registerWorkflowRoutes(a, { store })
  return a
}

describe('workflow routes (F2-AC4/AC6/AC10)', () => {
  it('POST validates and rejects a gate-capability violation with 400 + errors', async () => {
    app = build()
    const res = await app.inject({ method: 'POST', url: '/api/workflows', payload: { name: 'bad', agents: [{ role: 'proto', tools: ['run_tests'] }] } })
    expect(res.statusCode).toBe(400)
    expect(res.json().errors.join(' ')).toMatch(/gate capability/)
  })

  it('POST saves a valid workflow (201, version 1), edit bumps version (F2-AC10)', async () => {
    app = build()
    const created = (await app.inject({ method: 'POST', url: '/api/workflows', payload: { name: 'wf', agents: [{ role: 'scribe', model: { providerId: 'anthropic', modelId: 'claude-opus-4-8' } }] } })).json()
    expect(created.version).toBe(1)
    const edited = (await app.inject({ method: 'POST', url: '/api/workflows', payload: { id: created.id, name: 'wf', agents: [{ role: 'scribe' }, { role: 'proto' }] } })).json()
    expect(edited.version).toBe(2)
    // The old version is still retrievable unchanged.
    expect((await app.inject({ method: 'GET', url: `/api/workflows/${created.id}?version=1` })).json().agents).toHaveLength(1)
  })

  it('GET lists workflows; unknown id → 404', async () => {
    app = build()
    await app.inject({ method: 'POST', url: '/api/workflows', payload: { name: 'wf', agents: [{ role: 'scribe' }] } })
    expect((await app.inject({ method: 'GET', url: '/api/workflows' })).json()).toHaveLength(1)
    expect((await app.inject({ method: 'GET', url: '/api/workflows/nope' })).statusCode).toBe(404)
  })
})
