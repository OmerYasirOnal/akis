import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { type WorkflowConfig, type SessionState, isVerified } from '@akis/shared'
import type { Orchestrator } from '../orchestrator/Orchestrator.js'
import type { OrchestratorServices } from '../di/services.js'
import type { SeqEvent } from '../events/bus.js'
import type { WorkflowStore } from '../workflow/WorkflowStore.js'
import { sseEvent, sseControl, sseComment } from './sse.js'

export interface SessionsDeps {
  orchestrator: Orchestrator
  services: OrchestratorServices
  /** A session may be started bound to a saved workflow (F2-AC9/AC10): the route
   *  resolves it and builds a per-session orchestrator that applies its per-agent
   *  models + iterate budget + RAG, sharing the same store + bus. */
  workflowStore?: WorkflowStore
  makeOrchestrator?: (wf: WorkflowConfig) => Orchestrator
  /** Resolve the authenticated user id from a request (for per-user build history);
   *  returns undefined when unauthenticated. */
  userIdOf?: (req: FastifyRequest) => string | undefined
}

/** Per-connection write-buffer ceiling. A stalled client whose unflushed bytes
 *  exceed this is dropped rather than allowed to grow without bound (OOM guard).
 *  Full drain-based flow control is deferred (see spec out-of-scope). */
const MAX_SSE_BUFFER_BYTES = 1 << 20 // 1 MiB

/** Error class names that mean "a precondition/gate refused" -> 409, not 500.
 *  Reporting a gate refusal is observability; the gate still blocked the action. */
const CONFLICT_ERRORS = new Set([
  'SpecNotApprovedError',
  'NotVerifiedError',
  'CodeMismatchError',
  'WrongStatusError',
  'AlreadyPushedError',
  'CriticFailedError',
])

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  const name = err instanceof Error ? err.name : 'Error'
  const message = err instanceof Error ? err.message : String(err)
  // Narrow to the orchestrator/store "session <id> not found" message specifically,
  // so an unrelated provider error (e.g. "model not found") never mismaps to 404.
  if (/^session .+ not found$/.test(message)) return reply.code(404).send({ error: message, code: 'NotFound' })
  if (CONFLICT_ERRORS.has(name)) return reply.code(409).send({ error: message, code: name })
  return reply.code(500).send({ error: message, code: 'Internal' }) // message only, never internals/keys
}

/** Parse a resume cursor from the EventSource `Last-Event-ID` header (or a query
 *  fallback for the initial connect). Non-numeric/absent -> 0 (from the start). */
function parseCursor(header: unknown, query: unknown): number {
  const raw = (typeof header === 'string' && header) || (typeof query === 'string' && query) || ''
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}

export function registerSessionRoutes(app: FastifyInstance, deps: SessionsDeps): void {
  const { orchestrator, services } = deps
  // Per-session orchestrator for workflow-bound runs (captured at start → immutable
  // for that run even if the workflow is later edited, F2-AC10). Default otherwise.
  const bound = new Map<string, Orchestrator>()
  const orchestratorFor = (id: string): Orchestrator => bound.get(id) ?? orchestrator

  // Owner-scope single-session access: a session that carries an `ownerId` (started
  // while authenticated) is PRIVATE to that owner. An anonymous session (no ownerId —
  // keyless/unauthenticated runs, tests) stays open for backward compatibility.
  // Returns the session when the caller may access it, else null → the caller replies
  // 404 (so a non-owner can't even confirm someone else's session exists).
  const accessibleSession = async (req: FastifyRequest, id: string): Promise<SessionState | null> => {
    const s = await services.store.get(id)
    if (!s) return null
    if (s.ownerId && deps.userIdOf?.(req) !== s.ownerId) return null
    return s
  }
  const notFound = (reply: FastifyReply, id: string): FastifyReply =>
    reply.code(404).send({ error: `session ${id} not found`, code: 'NotFound' })

  app.post<{ Body: { idea?: string; workflowId?: string } }>('/sessions', async (req, reply) => {
    const idea = typeof req.body?.idea === 'string' ? req.body.idea.trim() : ''
    if (!idea) return reply.code(400).send({ error: 'idea required', code: 'BadRequest' })
    let orch = orchestrator
    const workflowId = req.body?.workflowId
    if (workflowId && deps.workflowStore && deps.makeOrchestrator) {
      const wf = deps.workflowStore.get(workflowId)
      if (!wf) return reply.code(404).send({ error: `workflow ${workflowId} not found`, code: 'NotFound' })
      orch = deps.makeOrchestrator(wf)
    }
    try {
      const ownerId = deps.userIdOf?.(req)
      const s = await orch.start({ idea, ...(ownerId ? { ownerId } : {}) })
      if (orch !== orchestrator) bound.set(s.id, orch)
      return reply.code(201).send(s)
    } catch (err) { return sendError(reply, err) }
  })

  // Per-user build history (newest first). Registered before /sessions/:id; Fastify
  // prioritizes the static path anyway. Auth required — lists only the caller's runs.
  app.get('/sessions/mine', async (req, reply) => {
    const ownerId = deps.userIdOf?.(req)
    if (!ownerId) return reply.code(401).send({ error: 'unauthorized', code: 'Unauthorized' })
    const list = await services.store.listByOwner(ownerId)
    return list.map(s => ({ id: s.id, idea: s.idea, status: s.status, verified: isVerified(s) }))
  })

  app.get<{ Params: { id: string } }>('/sessions/:id', async (req, reply) => {
    const s = await accessibleSession(req, req.params.id)
    if (!s) return notFound(reply, req.params.id)
    return reply.send(s)
  })

  const TERMINAL = new Set(['done', 'failed', 'cancelled'])
  const action = (run: (id: string) => Promise<unknown>) =>
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const id = req.params.id
      // Owner-scope: an owned session can only be driven by its owner (else 404,
      // before any orchestrator action runs).
      if (!(await accessibleSession(req, id))) return notFound(reply, id)
      try {
        const r = await run(id)
        // Release the per-session orchestrator once the run is terminal (no leak).
        if (r && typeof r === 'object' && 'status' in r && TERMINAL.has(String((r as { status: unknown }).status))) bound.delete(id)
        return reply.send(r)
      } catch (err) { return sendError(reply, err) }
    }

  app.post<{ Params: { id: string } }>('/sessions/:id/approve', action(id => orchestratorFor(id).approve(id)))
  app.post<{ Params: { id: string } }>('/sessions/:id/run', action(id => orchestratorFor(id).runToVerification(id)))
  app.post<{ Params: { id: string } }>('/sessions/:id/confirm', action(id => orchestratorFor(id).confirmPush(id)))

  // Batch event log: the retained {seq,event}[] for a session. The FE fetches this on
  // an SSE `reset` to rebuild its live view from the authoritative history (the SSE
  // stream alone can't, after a buffer drop), then resumes live from head (F2-AC12).
  app.get<{ Params: { id: string } }>('/sessions/:id/log', async (req, reply) => {
    const id = req.params.id
    const stored = await services.store.get(id)
    if (stored?.ownerId && deps.userIdOf?.(req) !== stored.ownerId) return notFound(reply, id) // owner-scope: no cross-user log read
    if (services.bus.head(id) === 0 && !stored) return notFound(reply, id)
    const { events, dropped } = services.bus.replaySince(id, 0)
    // `truncated` = the buffer already evicted head events (a >cap-event session), so
    // this log is a tail, not the full history — the client can surface that honestly.
    return reply.send({ events, head: services.bus.head(id), truncated: dropped })
  })

  // Resumable SSE stream (CF1 + CF5 / F2-AC12).
  app.get<{ Params: { id: string }; Querystring: { lastEventId?: string } }>(
    '/sessions/:id/events',
    async (req, reply) => {
      const id = req.params.id
      const stored = await services.store.get(id)
      // Owner-scope: a non-owner cannot stream someone else's owned session (404 before hijack).
      if (stored?.ownerId && deps.userIdOf?.(req) !== stored.ownerId) return notFound(reply, id)
      // 404 only when the session is truly unknown AND has emitted nothing.
      if (services.bus.head(id) === 0 && !stored) return notFound(reply, id)

      // Take over the response lifecycle: we stream on reply.raw and keep the
      // socket open, so Fastify must NOT try to send/close a reply for us.
      reply.hijack()
      const raw = reply.raw
      raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // disable proxy buffering
      })

      const cursor = parseCursor(req.headers['last-event-id'], req.query?.lastEventId)

      // One cleanup path, wired to BOTH 'close' and 'error'. After hijack(),
      // Fastify is out of the loop, so an unhandled socket 'error' (EPIPE/
      // ECONNRESET) would be an uncaught crash and the subscription would leak.
      let replaying = true
      let maxSent = cursor
      let closed = false
      let ping: ReturnType<typeof setInterval> | undefined
      let unsub: () => void = () => {}
      const queue: SeqEvent[] = []

      const cleanup = (): void => {
        if (closed) return
        closed = true
        if (ping) clearInterval(ping)
        unsub()
        try { raw.end() } catch { /* socket already gone */ } // release the FD on overflow-drop too
      }
      // All writes go through here: a throw (write to a destroyed socket) must
      // NEVER propagate into bus.emit()'s listener loop — it cleans up instead.
      // Memory is bounded: a stalled client whose kernel/Node buffer exceeds the
      // cap is dropped rather than allowed to grow without limit (backpressure).
      const safeWrite = (chunk: string): void => {
        if (closed) return
        try {
          raw.write(chunk)
          if (raw.writableLength > MAX_SSE_BUFFER_BYTES) cleanup()
        } catch { cleanup() }
      }
      // Subscribe BEFORE replay so an event emitted mid-replay is never lost.
      // Live frames arriving during replay are queued, then flushed deduped by seq.
      const write = (s: SeqEvent): void => {
        if (closed || s.seq <= maxSent) return // dedupe replay/live overlap
        safeWrite(sseEvent(s.seq, s.event))
        if (!closed) maxSent = s.seq
      }
      unsub = services.bus.subscribe(id, (event, seq) => {
        if (closed) return
        if (replaying) queue.push({ seq, event })
        else write({ seq, event })
      })

      const { dropped, events } = services.bus.replaySince(id, cursor)
      if (dropped) {
        // The buffer no longer covers the gap: tell the client to re-sync from
        // GET /sessions/:id/log and resume live from head (no silent loss). The id:
        // line advances Last-Event-ID so a drop right after reset resumes correctly.
        const head = services.bus.head(id)
        safeWrite(sseControl('reset', { head }, head))
        maxSent = head
      } else {
        for (const s of events) write(s)
      }
      replaying = false
      for (const s of queue) write(s)

      ping = setInterval(() => { if (!closed && !raw.writableNeedDrain) safeWrite(sseComment('ping')) }, 15000)
      if (typeof ping.unref === 'function') ping.unref()
      raw.on('close', cleanup)
      raw.on('error', cleanup) // the missing handler — prevents an uncaught crash
      // Keep the request open: do not return a body (Fastify won't close raw).
    },
  )
}
