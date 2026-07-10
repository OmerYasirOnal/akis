import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { StatsCollector } from '../analytics/StatsCollector.js'
import type { HttpMetrics } from '../analytics/HttpMetrics.js'
import type { PreviewRegistry } from '../preview/PreviewRegistry.js'
import type { AccessCheck } from '../auth/admin.js'

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
  /** Admin access guard (tri-state): 'ok' serves, 'unauthenticated' → 401, 'forbidden' → 403.
   *  Operator-only when an admin allowlist is configured; any-authenticated fallback otherwise. */
  guard: (req: FastifyRequest) => Promise<AccessCheck>
  /** Cumulative HTTP response counters (error rate, 429 spikes). Surfaced on /api/ops only. */
  httpMetrics?: HttpMetrics
  /** RAG ingest/corpus health (RagService.getMetrics) — present only when RAG is on. A thunk so
   *  ops.routes never imports knowledge internals (the port stays decoupled). */
  ragMetrics?: () => Record<string, unknown> | undefined
}

/**
 * GET /api/ops — the richer OPERATOR view: the full StatsCollector snapshot + the operational
 * block. /health stays the cheap public probe; this is ADMIN-gated (operator-only when an admin
 * allowlist is configured; any-authenticated otherwise). Exposes only counts/uptime/memory — no
 * keys, no DSN.
 */
export function registerOpsRoutes(app: FastifyInstance, deps: OpsRoutesDeps): void {
  app.get('/api/ops', async (req, reply) => {
    const access = await deps.guard(req)
    if (access === 'unauthenticated') return reply.code(401).send({ error: 'unauthorized', code: 'Unauthorized' })
    if (access === 'forbidden') return reply.code(403).send({ error: 'admin only', code: 'Forbidden' })
    const ops = await buildOpsBlock(deps.stats, deps.previewRegistry, deps.dbPing)
    const rag = deps.ragMetrics?.()
    return reply.send({
      ...deps.stats.snapshot(),
      ops,
      ...(deps.httpMetrics ? { http: deps.httpMetrics.snapshot() } : {}),
      ...(rag ? { rag } : {}),
    })
  })
}
