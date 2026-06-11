import http from 'node:http'
import net from 'node:net'
import type { FastifyInstance } from 'fastify'
import type { SessionStore } from '../store/SessionStore.js'
import type { SessionState } from '@akis/shared'
import type { EventBus } from '../events/bus.js'
import type { PreviewRegistry, PreviewEntry } from '../preview/PreviewRegistry.js'
import { detectAppType } from '../preview/AppDetector.js'
import { materialize } from '../preview/Workspace.js'
import { serveStatic } from '../preview/serveStatic.js'

export interface PreviewDeps {
  registry: PreviewRegistry
  store: SessionStore
  bus: EventBus
  /** Resolve the authenticated user id from a request (same closure as the session routes). When
   *  present, the session-control preview routes (boot/inspect/stop) are OWNER-SCOPED: an owned
   *  session is private to its owner, so a non-owner can't boot-and-run another user's generated
   *  code, stop their live preview, or inspect it. Absent (tests/host-injection) ⇒ open (today's
   *  behavior). Anonymous (ownerId-less) sessions stay open for backward compat. */
  userIdOf?: (req: import('fastify').FastifyRequest) => (string | undefined) | Promise<string | undefined>
  /** Upstream port resolver (defaults to the registry); injectable for tests. */
  portFor?: (sessionId: string) => number | undefined
}

/** Hop-by-hop headers (RFC 7230 §6.1) — never forwarded by a proxy. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])

/**
 * Rewrite a redirect `Location` that targets the internal loopback upstream
 * (http(s)://127.0.0.1:<port>/...) back to the browser-visible same-origin prefix
 * (/preview/:id/...), so the internal port never leaks into a browser-followed redirect.
 * Leaves already-relative or foreign locations untouched. Pure (exported for tests).
 */
export function rewriteLocation(location: string | undefined, id: string, port: number): string | undefined {
  if (location === undefined) return undefined
  const m = /^https?:\/\/127\.0\.0\.1:(\d+)(\/[^\s]*)?$/i.exec(location)
  if (!m || Number(m[1]) !== port) return location
  const rest = (m[2] ?? '/').replace(/^\//, '')
  return `/preview/${id}/${rest}`
}

/** Copy upstream response headers, dropping hop-by-hop and rewriting Location. */
function sanitizeResponseHeaders(headers: http.IncomingHttpHeaders, id: string, port: number): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {}
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue
    const lk = k.toLowerCase()
    if (HOP_BY_HOP.has(lk)) continue
    if (lk === 'location') { const rw = rewriteLocation(Array.isArray(v) ? v[0] : v, id, port); if (rw !== undefined) out[k] = rw; continue }
    out[k] = v
  }
  return out
}

/** Materialize a session's produced code and boot it in the registry (the POST /preview
 *  body, extracted so the ship-time PREWARM can reuse the exact same path). Returns the
 *  entry, or undefined when there is nothing to preview. */
export async function startPreviewForSession(
  store: PreviewDeps['store'],
  registry: PreviewDeps['registry'],
  id: string,
): Promise<PreviewEntry | undefined> {
  const session = await store.get(id)
  const files = session?.code?.files ?? []
  if (files.length === 0) return undefined
  const dir = await materialize(id, files)
  return registry.start(id, dir, detectAppType(files))
}

/**
 * PERCEIVED-LATENCY: pre-warm the preview the moment a session ships (the `done` event) —
 * install+boot happen while the user is still reading the shipped card, so the first
 * "Run app" click finds a READY entry instead of paying the whole boot. Fire-and-forget
 * and NON-GATING (the preview carries no verify/push authority; same sandbox posture as a
 * user-clicked Run — this only moves WHEN it starts).
 *
 * A3.3 — a `done` while a preview is already up means a REBUILD (change request) just shipped:
 *   - 'ready'    → RESTART. The live process/materialized dir serves the PREVIOUS build's bytes,
 *     and skipping emitted NO new preview_status frame — the user stared at the OLD app forever.
 *     startPreviewForSession re-materializes the NEW files into a fresh workspace and
 *     registry.start() stops the prior entry FIRST (same session slot — the maxConcurrent cap is
 *     reused, never consumed twice; the capacity gate below is for NEW slots only). Both serving
 *     types are covered by the same path: a node app re-boots (starting→ready frames), a static
 *     app re-points the entry's dir (a fresh ready frame) — either way the NEW bytes are served
 *     and a fresh 'ready' reaches the FE (which remounts the iframe on every ready fold).
 *   - 'starting' → still SKIP: a boot is already in flight — don't thrash it.
 */
export function wirePreviewPrewarm(
  bus: { tap(fn: (e: { kind: string; sessionId: string }) => void): () => void },
  store: PreviewDeps['store'],
  registry: PreviewDeps['registry'],
): () => void {
  return bus.tap(e => {
    if (e.kind !== 'done') return
    const cur = registry.get(e.sessionId)
    if (cur && cur.status === 'starting') return // boot in flight — don't thrash it
    if (cur && cur.status === 'ready') {
      // A3.3 restart (see the doc above) — bypasses the capacity gate: this session already
      // holds its slot and start() stops it before re-booting, so the cap can't be exceeded.
      void startPreviewForSession(store, registry, e.sessionId).catch(() => {
        /* best-effort: a failed re-warm leaves the next Run to pay the boot, as before */
      })
      return
    }
    // CAP (audit bigger-bet): a warm-up is never worth evicting a live preview or OOMing the box —
    // at capacity the prewarm silently skips; the user's explicit Run still works (it evicts).
    if (registry.atCapacity()) return
    void startPreviewForSession(store, registry, e.sessionId).catch(() => {
      /* best-effort: a failed prewarm just means Run pays the boot, as before */
    })
  })
}

/**
 * Preview lifecycle + a same-origin reverse proxy so the FE iframe can embed the
 * locally-running app at /preview/:id/* without X-Frame-Options conflicts. The
 * registry emits `preview_status` on the bus (wired at construction). The proxy is
 * read-only transport; it adds no gate authority.
 */
export function registerPreviewRoutes(app: FastifyInstance, deps: PreviewDeps): void {
  const portFor = deps.portFor ?? ((id: string) => deps.registry.portFor(id))

  // Owner-scope a session-control preview request: an owned session is PRIVATE to its owner, so a
  // non-owner gets 404 (existence not even confirmed) — mirrors sessions.routes' accessibleSession.
  // An anonymous (ownerId-less) session stays open. Returns the session when accessible, else null.
  const accessiblePreviewSession = async (req: import('fastify').FastifyRequest, id: string): Promise<SessionState | null> => {
    const session = await deps.store.get(id)
    if (!session) return null
    if (session.ownerId && (await deps.userIdOf?.(req)) !== session.ownerId) return null
    return session
  }

  app.post<{ Params: { id: string } }>('/sessions/:id/preview', async (req, reply) => {
    const id = req.params.id
    // OWNER-SCOPED: booting RUNS the session's generated code — a non-owner must never reach it.
    const session = await accessiblePreviewSession(req, id)
    if (!session) return reply.code(404).send({ error: `session ${id} not found`, code: 'NotFound' })
    const entry = await startPreviewForSession(deps.store, deps.registry, id)
    if (!entry) return reply.code(409).send({ error: 'no produced code to preview', code: 'NoCode' })
    return reply.send(entry)
  })

  app.get<{ Params: { id: string } }>('/sessions/:id/preview', async (req, reply) => {
    // OWNER-SCOPED: a non-owner can't inspect another user's preview status (404, like the POST).
    if (!(await accessiblePreviewSession(req, req.params.id))) return reply.code(404).send({ error: 'no preview', code: 'NotFound' })
    const e = deps.registry.get(req.params.id)
    if (!e) return reply.code(404).send({ error: 'no preview', code: 'NotFound' })
    return reply.send(e)
  })

  app.delete<{ Params: { id: string } }>('/sessions/:id/preview', async (req, reply) => {
    // OWNER-SCOPED: stopping another owner's live preview would be a cross-user DoS — 404 for them.
    if (!(await accessiblePreviewSession(req, req.params.id))) return reply.code(404).send({ error: 'no preview', code: 'NotFound' })
    await deps.registry.stop(req.params.id)
    return reply.send({ stopped: true })
  })

  // Same-origin reverse proxy to the running preview — in its OWN encapsulated scope with a
  // PASSTHROUGH content-type parser. Fastify's default JSON parser CONSUMES the request body
  // before the handler runs, so the old `req.raw.pipe(upstream)` forwarded ZERO bytes on
  // POST/PUT — the upstream waited for content-length forever and every body-carrying API
  // call through the proxy HUNG (caught LIVE: the generated voting app's /api/signup answered
  // 200 direct but timed out through the proxy). In this scope the body is never parsed:
  // `req.body` IS the raw stream, piped verbatim — JSON, forms and binary all survive.
  void app.register(async scope => {
    scope.removeAllContentTypeParsers()
    scope.addContentTypeParser('*', (_req, payload, done) => { done(null, payload) })
    scope.all<{ Params: { id: string; '*': string } }>('/preview/:id/*', async (req, reply) => {
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
      // Strip REQUEST-direction hop-by-hop headers too (final-review fix — RFC 7230 §6.1:
      // they describe THIS hop, not the upstream one; only response headers were sanitized).
      const fwdHeaders: Record<string, string | string[]> = { host: `127.0.0.1:${port}` }
      for (const [k, v] of Object.entries(req.headers)) {
        if (HOP_BY_HOP.has(k.toLowerCase()) || k.toLowerCase() === 'host' || v === undefined) continue
        fwdHeaders[k] = v
      }
      const upstream = http.request(
        { host: '127.0.0.1', port, path: subPath, method: req.method, headers: fwdHeaders },
        // Drop hop-by-hop headers and rewrite any Location back to /preview/:id/ so the
        // internal loopback port never surfaces in a browser-visible redirect.
        up => { raw.writeHead(up.statusCode ?? 502, sanitizeResponseHeaders(up.headers, id, port)); up.pipe(raw) },
      )
      upstream.on('error', () => { try { if (!raw.headersSent) raw.writeHead(502); raw.end('preview unavailable') } catch { /* socket gone */ } })
      // The passthrough parser hands us the UNCONSUMED body stream for every parsed request.
      // (GET/HEAD run no parser → req.body undefined → the req.raw fallback; for parsed
      // methods the '*' parser always yields a stream, so the fallback is effectively
      // GET/HEAD-only — comment corrected per the final review.)
      const body = req.body as NodeJS.ReadableStream | undefined
      if (body && typeof body.pipe === 'function') body.pipe(upstream)
      else req.raw.pipe(upstream)
    })
  })

  // Raw WebSocket upgrade tunnel for vite HMR (and any other ws under a preview). Fastify's
  // route layer doesn't see `Upgrade` requests, so we hook the underlying server. We ONLY
  // handle /preview/:id/* upgrades to a READY port; everything else is left untouched for
  // other upgrade handlers. The tunnel opens a raw net.connect to the loopback upstream,
  // replays the upgrade head verbatim, and pipes both directions. Defensive: any error
  // destroys both sockets (a half-open tunnel would hang the browser).
  app.server.on('upgrade', (req, socket, head) => {
    const url = req.url ?? ''
    const m = /^\/preview\/([^/]+)(\/.*)?$/.exec(url.split('?')[0] ?? '')
    // Registering ANY 'upgrade' listener disables Node's default of destroying unhandled upgrade
    // sockets — and this is the only such listener. So a non-preview upgrade (or one with no ready
    // port) MUST be destroyed, not left dangling: a bare `return` would leak the socket, an
    // unauthenticated FD-exhaustion surface (the listener sits below Fastify's auth hooks). (PR #83 review)
    if (!m) { socket.destroy(); return }
    const id = decodeURIComponent(m[1] ?? '')
    const port = portFor(id)
    if (port === undefined) { socket.destroy(); return }
    const subPath = (m[2] ?? '/') + (url.includes('?') ? '?' + url.slice(url.indexOf('?') + 1) : '')

    const upstream = net.connect(port, '127.0.0.1', () => {
      upstream.setTimeout(0) // connected — cancel the connect deadline (do NOT idle-kill a long-lived HMR ws)
      // Replay the request line + headers (host rewritten to the loopback upstream), then
      // any bytes already buffered by Node, then pipe both ways for the lifetime of the ws.
      const headerLines = [`${req.method} ${subPath} HTTP/1.1`]
      for (const [k, v] of Object.entries(req.headers)) {
        if (k.toLowerCase() === 'host') continue
        for (const val of Array.isArray(v) ? v : [v]) if (val !== undefined) headerLines.push(`${k}: ${val}`)
      }
      headerLines.push(`host: 127.0.0.1:${port}`)
      upstream.write(headerLines.join('\r\n') + '\r\n\r\n')
      if (head?.length) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.setTimeout(10_000) // bound the CONNECT phase only (cleared once connected)
    const destroy = (): void => { upstream.destroy(); socket.destroy() }
    // Reap BOTH sockets when EITHER errors OR closes (not just on error). On shutdown,
    // forceCloseConnections destroys the client `socket` (a tracked server connection) — its
    // 'close' then tears down the upstream net.connect socket (which Fastify does NOT track),
    // so no half-open tunnel survives to wedge close(). 'timeout' fires only for a stalled connect.
    upstream.on('error', destroy); upstream.on('close', destroy); upstream.on('timeout', destroy)
    socket.on('error', destroy); socket.on('close', destroy)
  })
  // Note: routes don't emit events directly — the registry's onStatus emits preview_status.
}
