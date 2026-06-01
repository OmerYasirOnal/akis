import type { FastifyInstance } from 'fastify'
import type { WorkflowConfigInput } from '@akis/shared'
import type { WorkflowStore } from '../workflow/WorkflowStore.js'
import { validateWorkflowConfig } from '../workflow/validate.js'

export interface WorkflowsDeps { store: WorkflowStore }

/**
 * Workflow preset CRUD. POST validates against the catalog + the role/gate matrix
 * (F2-AC4) and REJECTS at save time — a producer/custom agent granted a gate
 * capability, an unknown model, or an over-cap iterate budget never reaches a run.
 * Saving an existing id appends a new version (F2-AC10).
 */
export function registerWorkflowRoutes(app: FastifyInstance, deps: WorkflowsDeps): void {
  app.get('/api/workflows', async () => deps.store.list())

  app.get<{ Params: { id: string }; Querystring: { version?: string } }>('/api/workflows/:id', async (req, reply) => {
    const version = req.query.version !== undefined ? Number.parseInt(req.query.version, 10) : undefined
    const wf = deps.store.get(req.params.id, Number.isFinite(version as number) ? version : undefined)
    if (!wf) return reply.code(404).send({ error: 'workflow not found', code: 'NotFound' })
    return wf
  })

  app.post<{ Body: WorkflowConfigInput }>('/api/workflows', async (req, reply) => {
    const input = req.body
    const result = validateWorkflowConfig(input)
    if (!result.ok) return reply.code(400).send({ error: 'invalid workflow', code: 'Invalid', errors: result.errors })
    return reply.code(201).send(deps.store.save(input))
  })
}
