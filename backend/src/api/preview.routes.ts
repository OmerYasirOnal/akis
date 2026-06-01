import http from 'node:http'
import type { FastifyInstance } from 'fastify'
import type { SessionStore } from '../store/SessionStore.js'
import type { EventBus } from '../events/bus.js'
import type { PreviewRegistry } from '../preview/PreviewRegistry.js'
import { detectAppType } from '../preview/AppDetector.js'
import { materialize } from '../preview/Workspace.js'
import { serveStatic } from '../preview/serveStatic.js'

export interface PreviewDeps {
  registry: PreviewRegistry
  store: SessionStore
  bus: EventBus
  /** Upstream port resolver (defaults to the registry); injectable for tests. */
  portFor?: (sessionId: string) => number | undefined
}

/**
 * Preview lifecycle + a same-origin reverse proxy so the FE iframe can embed the
 * locally-running app at /preview/:id/* without X-Frame-Options conflicts. The
 * registry emits `preview_status` on the bus (wired at construction). The proxy is
 * read-only transport; it adds no gate authority.
 */
export function registerPreviewRoutes(app: FastifyInstance, deps: PreviewDeps): void {
  const portFor = deps.portFor ?? ((id: string) => deps.registry.portFor(id))

  app.post<{ Params: { id: string } }>('/sessions/:id/preview', async (req, reply) => {
    const id = req.params.id
    const session = await deps.store.get(id)
    if (!session) return reply.code(404).send({ error: `session ${id} not found`, code: 'NotFound' })
    const files = session.code?.files ?? []
    if (files.length === 0) return reply.code(409).send({ error: 'no produced code to preview', code: 'NoCode' })
    const dir = await materialize(id, files)
    const type = detectAppType(files)
    const entry = await deps.registry.start(id, dir, type)
    return reply.send(entry)
  })

  app.get<{ Params: { id: string } }>('/sessions/:id/preview', async (req, reply) => {
    const e = deps.registry.get(req.params.id)
    if (!e) return reply.code(404).send({ error: 'no preview', code: 'NotFound' })
    return reply.send(e)
  })

  app.delete<{ Params: { id: string } }>('/sessions/:id/preview', async (req, reply) => {
    await deps.registry.stop(req.params.id)
    return reply.send({ stopped: true })
  })

  // Same-origin reverse proxy to the running preview (HMR/websocket upgrade deferred).
  app.all<{ Params: { id: string; '*': string } }>('/preview/:id/*', async (req, reply) => {
    const id = req.params.id
    const subPath = '/' + (req.params['*'] ?? '')
    const port = portFor(id)
    if (port === undefined) {
      // Static preview: serve the materialized files directly (no upstream process).
      const sdir = deps.registry.staticDirFor(id)
      if (sdir) { const r = await serveStatic(sdir, subPath); return reply.code(r.code).type(r.type ?? 'application/octet-stream').send(r.body) }
      return reply.code(404).send({ error: 'no running preview', code: 'NotFound' })
    }
    reply.hijack()
    const raw = reply.raw
    const upstream = http.request(
      { host: '127.0.0.1', port, path: subPath, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${port}` } },
      up => { raw.writeHead(up.statusCode ?? 502, up.headers); up.pipe(raw) },
    )
    upstream.on('error', () => { try { if (!raw.headersSent) raw.writeHead(502); raw.end('preview unavailable') } catch { /* socket gone */ } })
    req.raw.pipe(upstream)
  })
  // Note: routes don't emit events directly — the registry's onStatus emits preview_status.
}
