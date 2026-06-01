import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Orchestrator } from '../orchestrator/Orchestrator.js'
import type { OrchestratorServices } from '../di/services.js'
import type { SeqEvent } from '../events/bus.js'
import { sseEvent, sseControl, sseComment } from './sse.js'

export interface SessionsDeps {
  orchestrator: Orchestrator
  services: OrchestratorServices
}

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
  if (message.includes('not found')) return reply.code(404).send({ error: message, code: 'NotFound' })
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

  app.post<{ Body: { idea?: string } }>('/sessions', async (req, reply) => {
    const idea = typeof req.body?.idea === 'string' ? req.body.idea.trim() : ''
    if (!idea) return reply.code(400).send({ error: 'idea required', code: 'BadRequest' })
    try {
      const s = await orchestrator.start({ idea })
      return reply.code(201).send(s)
    } catch (err) { return sendError(reply, err) }
  })

  app.get<{ Params: { id: string } }>('/sessions/:id', async (req, reply) => {
    const s = await services.store.get(req.params.id)
    if (!s) return reply.code(404).send({ error: `session ${req.params.id} not found`, code: 'NotFound' })
    return reply.send(s)
  })

  const action = (run: (id: string) => Promise<unknown>) =>
    async (req: { params: { id: string } }, reply: FastifyReply) => {
      try { return reply.send(await run(req.params.id)) }
      catch (err) { return sendError(reply, err) }
    }

  app.post<{ Params: { id: string } }>('/sessions/:id/approve', action(id => orchestrator.approve(id)))
  app.post<{ Params: { id: string } }>('/sessions/:id/run', action(id => orchestrator.runToVerification(id)))
  app.post<{ Params: { id: string } }>('/sessions/:id/confirm', action(id => orchestrator.confirmPush(id)))

  // Resumable SSE stream (CF1 + CF5 / F2-AC12).
  app.get<{ Params: { id: string }; Querystring: { lastEventId?: string } }>(
    '/sessions/:id/events',
    async (req, reply) => {
      const id = req.params.id
      // 404 only when the session is truly unknown AND has emitted nothing.
      if (services.bus.head(id) === 0 && !(await services.store.get(id))) {
        return reply.code(404).send({ error: `session ${id} not found`, code: 'NotFound' })
      }

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

      // Subscribe BEFORE replay so an event emitted mid-replay is never lost.
      // Live frames arriving during replay are queued, then flushed deduped by seq.
      let replaying = true
      let maxSent = cursor
      const queue: SeqEvent[] = []
      const write = (s: SeqEvent): void => {
        if (s.seq <= maxSent) return // already delivered (replay/live overlap) — dedupe
        raw.write(sseEvent(s.seq, s.event))
        maxSent = s.seq
      }
      const unsub = services.bus.subscribe(id, (event, seq) => {
        if (replaying) queue.push({ seq, event })
        else write({ seq, event })
      })

      const { dropped, events } = services.bus.replaySince(id, cursor)
      if (dropped) {
        // The buffer no longer covers the gap: tell the client to re-sync from
        // GET /sessions/:id and resume live from head (no silent loss).
        const head = services.bus.head(id)
        raw.write(sseControl('reset', { head }))
        maxSent = head
      } else {
        for (const s of events) write(s)
      }
      replaying = false
      for (const s of queue) write(s)

      const ping = setInterval(() => raw.write(sseComment('ping')), 15000)
      if (typeof ping.unref === 'function') ping.unref()
      raw.on('close', () => { clearInterval(ping); unsub() })
      // Keep the request open: do not return a body (Fastify won't close raw).
    },
  )
}
