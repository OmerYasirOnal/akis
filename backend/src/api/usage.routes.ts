import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { UsageStorePort } from '../usage/UsageStore.js'
import { checkQuota, type QuotaPolicy } from '../usage/quota.js'

export interface UsageRoutesDeps {
  usage: UsageStorePort
  quota: QuotaPolicy
  /** Resolve the authenticated user id (undefined ⇒ unauthenticated → 401). Mirrors
   *  /sessions/mine: usage is PER-USER, so an anonymous caller gets 401 (not the __anon__ row). */
  requireOwner: (req: FastifyRequest) => Promise<string | undefined>
}

/**
 * GET /api/usage — the authenticated caller's current token usage vs. their budget. Drives the
 * FE usage indicator. Token COUNTS are not secrets. `budget:0` (unlimited) returns
 * `{usedTokens:0, budget:0, remaining:-1, resetAt:''}` so the FE renders "unlimited".
 */
export function registerUsageRoutes(app: FastifyInstance, deps: UsageRoutesDeps): void {
  app.get('/api/usage', async (req, reply) => {
    const ownerId = await deps.requireOwner(req)
    if (!ownerId) return reply.code(401).send({ error: 'unauthorized', code: 'Unauthorized' })
    const d = await checkQuota(deps.usage, deps.quota, ownerId)
    return reply.send({ usedTokens: d.usedTokens, budget: d.budget, remaining: d.remaining, resetAt: d.resetAt })
  })
}
