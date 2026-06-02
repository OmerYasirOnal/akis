import type { FastifyInstance } from 'fastify'
import type { StatsCollector } from '../analytics/StatsCollector.js'

/** GET /api/analytics — aggregate run stats for the dashboard (observability only). */
export function registerAnalyticsRoutes(app: FastifyInstance, deps: { stats: StatsCollector }): void {
  app.get('/api/analytics', async () => deps.stats.snapshot())
}
