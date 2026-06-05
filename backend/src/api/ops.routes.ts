import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { StatsCollector } from '../analytics/StatsCollector.js'
import type { PreviewRegistry } from '../preview/PreviewRegistry.js'

/** The operational health block (no secrets — only counts/uptime/memory). Shared by the
 *  enriched /health probe and the richer /api/ops operator view. */
export interface OpsBlock {
  uptimeSec: number
  memory: { rssMb: number; heapUsedMb: number }
  activeSessions: number
  livePreviews: number
  db: 'ok' | 'degraded' | 'off'
}

const mb = (bytes: number): number => Math.round(bytes / (1024 * 1024))

/**
 * Build the operational block: uptime + memory (rounded MB) + active sessions (StatsCollector's
 * running counter) + live preview child processes + DB reachability. `dbPing` (when present) is
 * a BOUNDED probe (the caller wraps it in a 500ms Promise.race); absent ⇒ db:'off' (no DB).
 */
export async function buildOpsBlock(
  stats: StatsCollector,
  previewRegistry: PreviewRegistry,
  dbPing?: () => Promise<boolean>,
): Promise<OpsBlock> {
  const m = process.memoryUsage()
  let db: 'ok' | 'degraded' | 'off' = 'off'
  if (dbPing) {
    try { db = (await dbPing()) ? 'ok' : 'degraded' } catch { db = 'degraded' }
  }
  return {
    uptimeSec: Math.round(process.uptime()),
    memory: { rssMb: mb(m.rss), heapUsedMb: mb(m.heapUsed) },
    activeSessions: stats.snapshot().running,
    livePreviews: previewRegistry.runningCount(),
    db,
  }
}

export interface OpsRoutesDeps {
  stats: StatsCollector
  previewRegistry: PreviewRegistry
  /** Bounded DB reachability probe (built in start() with a 500ms timeout). Absent ⇒ db:'off'. */
  dbPing?: () => Promise<boolean>
  /** Auth guard (the same hasSession used for provider-key writes). */
  requireAuth: (req: FastifyRequest) => Promise<boolean>
}

/**
 * GET /api/ops — the richer OPERATOR view (authenticated): the full StatsCollector snapshot +
 * the operational block. /health stays the cheap public probe; this is gated behind the same
 * session guard used for provider-key writes. Exposes only counts/uptime/memory — no keys, no DSN.
 */
export function registerOpsRoutes(app: FastifyInstance, deps: OpsRoutesDeps): void {
  app.get('/api/ops', async (req, reply) => {
    if (!(await deps.requireAuth(req))) return reply.code(401).send({ error: 'unauthorized', code: 'Unauthorized' })
    const ops = await buildOpsBlock(deps.stats, deps.previewRegistry, deps.dbPing)
    return reply.send({ ...deps.stats.snapshot(), ops })
  })
}
