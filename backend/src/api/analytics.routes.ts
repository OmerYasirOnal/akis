import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { StatsCollector } from '../analytics/StatsCollector.js'
import type { AccessCheck } from '../auth/admin.js'

/**
 * GET /api/analytics — aggregate, cross-user run stats (observability only). ADMIN-gated: this is
 * the SAME global snapshot /api/ops serves, so it is operator-only when an admin allowlist is
 * configured (reviewer MED — it used to be fully PUBLIC). Any-authenticated fallback when no
 * allowlist is set (byte-identical single-operator). 403 (not 401) for an authed non-admin so the
 * FE doesn't treat it as a session-expiry and log the user out.
 */
export function registerAnalyticsRoutes(app: FastifyInstance, deps: { stats: StatsCollector; guard: (req: FastifyRequest) => Promise<AccessCheck> }): void {
  app.get('/api/analytics', async (req: FastifyRequest, reply: FastifyReply) => {
    const access = await deps.guard(req)
    if (access === 'unauthenticated') return reply.code(401).send({ error: 'unauthorized', code: 'Unauthorized' })
    if (access === 'forbidden') return reply.code(403).send({ error: 'admin only', code: 'Forbidden' })
    return deps.stats.snapshot()
  })
}
