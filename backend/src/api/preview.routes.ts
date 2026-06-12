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
import { digestFiles } from '../verify/digest.js'

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

/** The RAW boot work: materialize a session's produced code and start it in the registry. Returns
 *  the entry, or undefined when there is nothing to preview. NOT called directly — it runs ONLY
 *  inside the per-session serializer (see PreviewStartCoordinator) so two concurrent boots for one
 *  session can never interleave (caller B's start() would tear down caller A's materialized dir,
 *  and A's failure path would clobber B's ready entry — PreviewRegistry.ts unconditional set/delete).
 *
 *  `evict` (review 3399732530): an EXPLICIT user start (the POST route / FE auto-run) passes 'allow'
 *  (the registry may evict the oldest heavy preview at capacity — the user asked for THIS one); a
 *  BACKGROUND start (the done-tap restart / prewarm) passes 'never' so a warm-up declines at capacity
 *  rather than killing another session's live preview. The materialized RepoFiles' digest is recorded
 *  on the ready entry (review 3399732516) so a later done can skip a restart for identical bytes. */
async function materializeAndStart(
  store: PreviewDeps['store'],
  registry: PreviewDeps['registry'],
  id: string,
  evict: 'allow' | 'never' = 'allow',
): Promise<PreviewEntry | undefined> {
  const session = await store.get(id)
  const files = session?.code?.files ?? []
  if (files.length === 0) return undefined
  const digest = digestFiles(files)
  const dir = await materialize(id, files)
  return registry.start(id, dir, detectAppType(files), { digest, evict })
}

/** The digest of a session's CURRENT produced code (the bytes a restart WOULD serve), or undefined
 *  when there is nothing to preview. Used by the done-tap to skip a restart when the live entry's
 *  recorded digest already matches — identical bytes (review 3399732516). */
async function currentCodeDigest(store: PreviewDeps['store'], id: string): Promise<string | undefined> {
  const session = await store.get(id)
  const files = session?.code?.files ?? []
  if (files.length === 0) return undefined
  return digestFiles(files)
}

/**
 * F1 — PER-SESSION START SERIALIZATION. Every door into a preview boot for one session (the manual
 * POST route, the FE auto-run, the ship-time restart tap) funnels through ONE coordinator so:
 *   (a) two concurrent starts for a session are IMPOSSIBLE — a second caller COALESCES onto the
 *       in-flight promise instead of racing (the destructive interleave above).
 *   (b) a `done` arriving while a start/restart is in flight is NOT dropped: it sets a pending-done
 *       flag and the in-flight start's .finally runs exactly ONE trailing restart (many → one).
 *   (c) before a RESTART (the done-with-ready trigger) the registry entry is re-read INSIDE the
 *       serialized section — if it is no longer 'ready' (user pressed Stop, or it was evicted in the
 *       async window) the restart is SKIPPED, so a teardown isn't immediately undone.
 *
 * The registry's OWN internals (eviction, cap) are out of scope — this is route-level serialization.
 */
class PreviewStartCoordinator {
  private inFlight = new Map<string, Promise<PreviewEntry | undefined>>()
  private pendingDone = new Set<string>()
  constructor(private store: PreviewDeps['store'], private registry: PreviewDeps['registry']) {}

  /** Serialized start for an EXPLICIT request (POST route / FE auto-run). Coalesces onto an in-flight
   *  start for the same session (the second caller awaits the first's result — no second boot). */
  start(id: string): Promise<PreviewEntry | undefined> {
    return this.serialize(id, () => materializeAndStart(this.store, this.registry, id))
  }

  /** The ship-time `done` tap. Decides skip/restart/prewarm, but the in-flight check comes FIRST so a
   *  `done` landing mid-start is COALESCED into a single trailing restart rather than thrashing. */
  onDone(id: string): void {
    // A start/restart is already running → record the done; the in-flight .finally runs ONE trailing
    // restart. (Coalesces N rapid dones to one — they all just (re)set the same flag.)
    if (this.inFlight.has(id)) { this.pendingDone.add(id); return }
    const cur = this.registry.get(id)
    if (cur && cur.status === 'starting') return // an untracked boot is in flight — don't thrash it
    if (cur && cur.status === 'ready') { void this.restart(id); return }
    // CAP (audit bigger-bet): a warm-up is never worth evicting a live preview or OOMing the box — at
    // capacity the prewarm silently skips; the user's explicit Run still works (it evicts).
    if (this.registry.atCapacity()) return
    // A first-time prewarm (no live entry) is a BACKGROUND start → evict:'never' (a warm-up never
    // evicts a live preview, even though the atCapacity() check above already declines most cases —
    // belt and suspenders against a TOCTOU between the check and the registry's own cap).
    void this.serialize(id, () => materializeAndStart(this.store, this.registry, id, 'never')).catch(() => {})
  }

  /** A3.3 RESTART (done-with-ready): re-boot the live preview to serve a rebuild's NEW bytes. Two
   *  preconditions are re-checked INSIDE the serialized section (consistent with F1's coalescing):
   *   (c) LIVENESS — the entry must still be 'ready'; a Stop/eviction in the async window means there
   *       is nothing live to restart, so it's skipped (a teardown is not immediately undone).
   *   (digest, review 3399732516) IDENTICAL-BYTES — if the live entry's recorded digest equals the
   *       session's CURRENT code digest, the rebuild produced the SAME bytes (e.g. confirmPush emits
   *       `done` for unchanged code): SKIP, so we don't kill an app the user is inspecting nor re-pay
   *       npm install for identical code. A DIFFERING (or absent) digest still restarts — the A3.3
   *       stale-bytes guarantee. Background start ⇒ evict:'never' (this session already holds its slot;
   *       registry.start() stops its prior entry first, so it reuses the slot and evicts no one). */
  private restart(id: string): Promise<PreviewEntry | undefined> {
    return this.serialize(id, async () => {
      const cur = this.registry.get(id)
      if (!cur || cur.status !== 'ready') return undefined // (c) Stop/evicted → skip
      // Identical-bytes skip: only when the live entry HAS a recorded digest (a pre-digest entry has
      // none → conservatively restart) and it matches the session's current code digest.
      if (cur.digest !== undefined) {
        const now = await currentCodeDigest(this.store, id)
        if (now !== undefined && now === cur.digest) return cur // unchanged bytes → leave it running
      }
      return materializeAndStart(this.store, this.registry, id, 'never')
    }).catch(() => undefined) // best-effort: a failed re-warm leaves the next Run to pay the boot
  }

  /** Run `work` as the session's SOLE in-flight start; coalesce concurrent callers onto it. The
   *  .finally drains exactly ONE pending-done into a trailing restart (then loops only if another
   *  done landed during THAT restart — bounded coalescing, never an unbounded chain). */
  private serialize(id: string, work: () => Promise<PreviewEntry | undefined>): Promise<PreviewEntry | undefined> {
    const existing = this.inFlight.get(id)
    if (existing) return existing
    const p = (async () => work())()
      .finally(() => {
        this.inFlight.delete(id)
        if (this.pendingDone.delete(id)) void this.restart(id) // (b) one trailing restart, coalesced
      })
    this.inFlight.set(id, p)
    return p
  }
}

/** Per-REGISTRY coordinator (a worktree/test may build several registries; each gets its own
 *  serializer state). The POST route and the prewarm tap are wired with the SAME registry instance,
 *  so they share ONE coordinator — that is what makes their starts mutually serialized. */
const coordinators = new WeakMap<object, PreviewStartCoordinator>()
function coordinatorFor(store: PreviewDeps['store'], registry: PreviewDeps['registry']): PreviewStartCoordinator {
  let c = coordinators.get(registry as object)
  if (!c) { c = new PreviewStartCoordinator(store, registry); coordinators.set(registry as object, c) }
  return c
}

/** Materialize a session's produced code and boot it in the registry (the POST /preview body + the
 *  FE auto-run), SERIALIZED per session (F1). Returns the entry, or undefined when there is nothing
 *  to preview (or a concurrent start already owns the boot — the coalesced result). */
export async function startPreviewForSession(
  store: PreviewDeps['store'],
  registry: PreviewDeps['registry'],
  id: string,
): Promise<PreviewEntry | undefined> {
  return coordinatorFor(store, registry).start(id)
}

/**
 * PERCEIVED-LATENCY: pre-warm the preview the moment a session ships (the `done` event) —
 * install+boot happen while the user is still reading the shipped card, so the first
 * "Run app" click finds a READY entry instead of paying the whole boot. Fire-and-forget
 * and NON-GATING (the preview carries no verify/push authority; same sandbox posture as a
 * user-clicked Run — this only moves WHEN it starts).
 *
 * A3.3 — a `done` while a preview is already up means a REBUILD (change request) just shipped:
 *   - 'ready'    → RESTART (re-materialize the NEW files; registry.start() stops the prior entry
 *     first → the maxConcurrent cap is reused, never doubled). A node app re-boots, a static app
 *     re-points its dir; either way a fresh 'ready' reaches the FE.
 *   - 'starting' → SKIP: a boot is already in flight — don't thrash it.
 *
 * F1 — the tap delegates to the shared per-session coordinator so a `done` can never race the
 * manual POST start, and a `done` landing mid-boot is coalesced into one trailing restart.
 */
export function wirePreviewPrewarm(
  bus: { tap(fn: (e: { kind: string; sessionId: string }) => void): () => void },
  store: PreviewDeps['store'],
  registry: PreviewDeps['registry'],
): () => void {
  const coordinator = coordinatorFor(store, registry)
  return bus.tap(e => {
    if (e.kind !== 'done') return
    coordinator.onDone(e.sessionId)
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
