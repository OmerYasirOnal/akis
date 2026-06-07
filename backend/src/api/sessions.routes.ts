import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { randomUUID } from 'node:crypto'
import { type WorkflowConfig, type SessionState, type PublishRecord, type ExternalWriteRecord, EXTERNAL_WRITES_MAX, isVerified } from '@akis/shared'
import { digestExternalWrite, mintApprovedExternalWrite, executeExternalWrite, isAllowedExternalWriteAction, type ExternalWriteProposal } from '../gates/externalWriteGate.js'
import { mcpTransportFor } from './mcpConnect.routes.js'
import type { Orchestrator } from '../orchestrator/Orchestrator.js'
import type { OrchestratorServices } from '../di/services.js'
import type { SeqEvent } from '../events/bus.js'
import type { WorkflowStorePort } from '../workflow/WorkflowStore.js'
import type { PublishProfileStore, PublishProfile } from '../keys/PublishProfileStore.js'
import { WrongStatusError } from '../orchestrator/Orchestrator.js'
import { sseEvent, sseControl, sseComment } from './sse.js'
import { verifyPassport } from '../verify/passport.js'
import { buildAttestation, attestationMarkdown } from '../verify/attestation.js'
import { buildTrustReport, renderTrustReportMarkdown } from '../report/trustReport.js'
import type { UsageStorePort } from '../usage/UsageStore.js'
import { checkQuota, type QuotaPolicy } from '../usage/quota.js'

/** The publish seam the route calls — a function producing a PublishRecord from a session's files
 *  + the owner's decrypted profile. Real OpenSshTransport-backed in prod (wired in server.ts);
 *  an injected fake in tests. ADDITIVE + NON-GATING: the route persists the returned record via
 *  the GENERIC store.update patch (NOT a gate method) and NEVER moves the session status. */
export type SessionPublisher = (args: { files: { filePath: string; content: string }[]; profile: PublishProfile }) => Promise<PublishRecord>

/** Raised when the owner has no USABLE publish profile (none stored, or undecryptable — a rotated
 *  master reads as no-profile, fail-closed). Mapped to 409 via CONFLICT_ERRORS, like a gate refusal. */
export class NoPublishProfileError extends Error {
  constructor() { super('no publish destination configured (set one in Settings)'); this.name = 'NoPublishProfileError' }
}

export interface SessionsDeps {
  orchestrator: Orchestrator
  services: OrchestratorServices
  /** A session may be started bound to a saved workflow (F2-AC9/AC10): the route
   *  resolves it and builds a per-session orchestrator that applies its per-agent
   *  models + iterate budget + RAG, sharing the same store + bus. */
  workflowStore?: WorkflowStorePort
  makeOrchestrator?: (wf: WorkflowConfig) => Orchestrator
  /** Resolve the authenticated user id from a request (for per-user build history);
   *  returns undefined when unauthenticated. */
  userIdOf?: (req: FastifyRequest) => (string | undefined) | Promise<string | undefined>
  /** Per-user token-quota PRE-CHECK (multi-tenant safety). When BOTH are injected, POST /sessions
   *  refuses to START a build (429) for an owner over budget — BEFORE any orchestrator/provider
   *  call. Absent (tests that don't inject) ⇒ no check (byte-identical). SACRED: a start-only
   *  pre-check; an already-running session is never read or aborted. */
  usage?: UsageStorePort
  quota?: QuotaPolicy
  /** Per-user publish destination store (the encrypted SSH key + host/dir/port). Present ⇒ the
   *  POST /sessions/:id/publish action is enabled. Absent ⇒ publish is 409 NoPublishProfile. */
  publishProfiles?: PublishProfileStore
  /** The publish seam (deploy to the owner's own server). Present ALONGSIDE publishProfiles ⇒
   *  publish works; absent ⇒ the action is unavailable. NON-GATING (see SessionPublisher). */
  publisher?: SessionPublisher
  /** Durable audit ledger (Move 3a; present when DATABASE_URL is set). Enables GET
   *  /sessions/:id/audit — the owner-scoped, restart-durable chronological event trail. Absent ⇒
   *  the route falls back to the in-memory bus replay (today's behavior, just not durable). */
  auditStore?: import('../audit/AuditLog.js').AuditStore
  /** Per-(user,provider) remote-MCP OAuth store — enables the external-write CONFIRM route to build a
   *  per-user transport (mcpTransportFor) and EXECUTE a human-confirmed Jira/Confluence write. Absent
   *  ⇒ the propose/list routes still work but confirm replies 409 (no remote-MCP store wired). */
  mcpAuthStore?: import('../agent/mcp/StoreBackedOAuthProvider.js').RemoteMcpAuthStore
  /** Process env (PUBLIC_BASE_URL + the provider registry) for mcpTransportFor. */
  env?: NodeJS.ProcessEnv
  /** INJECTABLE per-user transport factory (tests). Default = the real mcpTransportFor (builds an
   *  OAuth-backed HttpMcpTransport for a connected provider). Typed to the McpTransport SEAM so a
   *  test can inject a fake; the real factory (returning HttpMcpTransport) satisfies it. */
  mcpTransportFor?: (opts: { userId: string; provider: string; store: import('../agent/mcp/StoreBackedOAuthProvider.js').RemoteMcpAuthStore; env: NodeJS.ProcessEnv }) => import('../agent/mcp/McpTransport.js').McpTransport | undefined
  /** Refuse to START a build for an UNAUTHENTICATED caller (no ownerId). Default false = anonymous
   *  builds allowed (the keyless-demo experience + today's behavior). Set true for a public/shared
   *  deployment so a build is always owned (no public-by-UUID anonymous session). Owner-scoping of
   *  EXISTING sessions is unchanged either way. */
  requireAuthForBuilds?: boolean
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
  // Publish (non-gating): no usable publish destination → 409, exactly like a gate refusal maps
  // (reporting the precondition is observability; nothing was published). Publish itself NEVER
  // gates/blocks/mints — see the POST /sessions/:id/publish handler.
  'NoPublishProfileError',
])

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  const name = err instanceof Error ? err.name : 'Error'
  const message = err instanceof Error ? err.message : String(err)
  // Narrow to the orchestrator/store "session <id> not found" message specifically,
  // so an unrelated provider error (e.g. "model not found") never mismaps to 404.
  if (/^session .+ not found$/.test(message)) return reply.code(404).send({ error: message, code: 'NotFound' })
  if (CONFLICT_ERRORS.has(name)) return reply.code(409).send({ error: message, code: name })
  // KNOWN GitHub delivery-target failure (missing/invalid repo, bad token, rate-limit): a client-side
  // misconfiguration of the push destination, NOT an AKIS internal fault. Map it to a 4xx with the
  // stable `GitHubDeliveryError` code (the FE localizes it via recovery.push.*) instead of leaking
  // the raw English provider string as a 500. An upstream 429 is forwarded AS 429 — it is transient
  // (back off and retry), not a misconfiguration, so collapsing it to 422 would drop that signal.
  // Gate-neutral: confirmPush already parked the run push_failed (retryable) before re-throwing —
  // see Orchestrator.confirmPush.
  if (name === 'GitHubDeliveryError') {
    const upstream = (err as { status?: unknown }).status
    return reply.code(upstream === 429 ? 429 : 422).send({ error: message, code: 'GitHubDeliveryError' })
  }
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
  // BOUNDED (audit #42): entries are deleted on a TERMINAL action, but a run that PARKS
  // non-terminally (verify_failed/awaiting_*) and is then ABANDONED would never be deleted.
  // A FIFO size cap evicts the oldest abandoned binding; an evicted retry simply falls back to the
  // default orchestrator (orchestratorFor) — degraded to default models, never a gate/correctness break.
  const BOUND_ORCH_MAX = 64
  const bound = new Map<string, Orchestrator>()
  const bindOrchestrator = (id: string, orch: Orchestrator): void => {
    bound.set(id, orch)
    while (bound.size > BOUND_ORCH_MAX) {
      const oldest = bound.keys().next().value
      if (oldest === undefined) break
      bound.delete(oldest)
    }
  }
  const orchestratorFor = (id: string): Orchestrator => bound.get(id) ?? orchestrator

  // Owner-scope single-session access: a session that carries an `ownerId` (started
  // while authenticated) is PRIVATE to that owner. An anonymous session (no ownerId —
  // keyless/unauthenticated runs, tests) stays open for backward compatibility.
  // Returns the session when the caller may access it, else null → the caller replies
  // 404 (so a non-owner can't even confirm someone else's session exists).
  const accessibleSession = async (req: FastifyRequest, id: string): Promise<SessionState | null> => {
    const s = await services.store.get(id)
    if (!s) return null
    if (s.ownerId && (await deps.userIdOf?.(req)) !== s.ownerId) return null
    return s
  }
  const notFound = (reply: FastifyReply, id: string): FastifyReply =>
    reply.code(404).send({ error: `session ${id} not found`, code: 'NotFound' })

  app.post<{ Body: { idea?: string; workflowId?: string; baseSessionId?: string; spec?: { title?: unknown; body?: unknown } } }>('/sessions', async (req, reply) => {
    const idea = typeof req.body?.idea === 'string' ? req.body.idea.trim() : ''
    if (!idea) return reply.code(400).send({ error: 'idea required', code: 'BadRequest' })
    // P0-1: an OPTIONAL chat-approved spec seed. When present it must be a well-shaped object
    // ({title, body} both non-empty strings) — the chat SpecCard's text is AUTHORITATIVE, so the
    // orchestrator uses it as-is and auto-satisfies Gate 1 (still minted server-side via the
    // approvalAuthority). A malformed seed is rejected (400) rather than silently dropped, so a
    // build never proceeds on a half-formed spec the human did not actually approve.
    let spec: { title: string; body: string } | undefined
    const rawSpec = req.body?.spec
    if (rawSpec !== undefined) {
      const title = typeof rawSpec.title === 'string' ? rawSpec.title.trim() : ''
      const body = typeof rawSpec.body === 'string' ? rawSpec.body.trim() : ''
      if (!title || !body) return reply.code(400).send({ error: 'spec must have a non-empty title and body', code: 'BadRequest' })
      spec = { title, body }
    }
    let orch = orchestrator
    const workflowId = req.body?.workflowId
    if (workflowId && deps.workflowStore && deps.makeOrchestrator) {
      const wf = await deps.workflowStore.get(workflowId)
      if (!wf) return reply.code(404).send({ error: `workflow ${workflowId} not found`, code: 'NotFound' })
      orch = deps.makeOrchestrator(wf)
    }
    // EDIT MODE (Phase B.5): seed the new build with a prior session's app so it is EDITED,
    // not regenerated. Owner-scoped exactly like every other session read (404 for non-owner,
    // so a foreign session's existence — let alone its code — is never confirmed).
    let base: { files: { filePath: string; content: string }[]; fromSession: string } | undefined
    const baseSessionId = req.body?.baseSessionId
    if (typeof baseSessionId === 'string' && baseSessionId) {
      const prior = await accessibleSession(req, baseSessionId)
      if (!prior) return notFound(reply, baseSessionId)
      if (prior.code?.files.length) base = { files: prior.code.files, fromSession: prior.id }
    }
    try {
      const ownerId = await deps.userIdOf?.(req)
      // Locked-down deployments require every build to be OWNED — refuse an anonymous (public-by-UUID)
      // build. Default off so the keyless-demo + existing behavior is byte-identical. (Audit #29.)
      if (deps.requireAuthForBuilds && !ownerId) return reply.code(401).send({ error: 'sign in to start a build', code: 'Unauthorized' })
      // Per-user token-quota PRE-CHECK (SACRED: start-only, fail-closed, never touches a gate or
      // an in-flight run). Only when BOTH usage + quota are injected; budget 0 ⇒ unlimited via
      // checkQuota's fast-path (no store read, byte-identical default). A blocked owner gets a
      // clean 429 BEFORE orch.start — no orchestrator/provider call happens.
      if (deps.usage && deps.quota) {
        const decision = await checkQuota(deps.usage, deps.quota, ownerId)
        if (!decision.allowed) return reply.code(429).send({ error: 'token quota exceeded', code: 'QuotaExceeded', resetAt: decision.resetAt })
      }
      const s = await orch.start({ idea, ...(ownerId ? { ownerId } : {}), ...(spec ? { spec } : {}), ...(base ? { base } : {}) })
      if (orch !== orchestrator) bindOrchestrator(s.id, orch)
      return reply.code(201).send(s)
    } catch (err) { return sendError(reply, err) }
  })

  // Per-user build history (newest first). Registered before /sessions/:id; Fastify
  // prioritizes the static path anyway. Auth required — lists only the caller's runs.
  app.get('/sessions/mine', async (req, reply) => {
    const ownerId = await deps.userIdOf?.(req)
    if (!ownerId) return reply.code(401).send({ error: 'unauthorized', code: 'Unauthorized' })
    // PROJECTION (audit quick-win): only the 4 rendered fields cross the wire/DB — the full
    // code/spec jsonb no longer ships per history view. Semantics identical (real isVerified).
    return services.store.listSummariesByOwner(ownerId)
  })

  app.get<{ Params: { id: string } }>('/sessions/:id', async (req, reply) => {
    const s = await accessibleSession(req, req.params.id)
    if (!s) return notFound(reply, req.params.id)
    return reply.send(s)
  })

  // Read path: the durable, third-party-verifiable Build Passport for a session. Returns the
  // signed passport, the server's trusted public key, and a SERVER-SIDE verification result
  // (verified against the trusted key the server holds — NOT just the key embedded on the
  // passport, so a passport carrying an attacker's own key+signature reads `verified:false`).
  // The PRIVATE key is NEVER exposed. 404 when the session is unknown/unauthorized; 404 with
  // a clear code when this session has no passport yet (no verified build signed one).
  app.get<{ Params: { id: string } }>('/sessions/:id/passport', async (req, reply) => {
    const s = await accessibleSession(req, req.params.id)
    if (!s) return notFound(reply, req.params.id)
    if (!s.passport) return reply.code(404).send({ error: 'no passport for this session', code: 'NoPassport' })
    const trustedKey = services.passportSigner?.publicKey
    // Verify against the server's TRUSTED key when configured; else fall back to the passport's
    // embedded key (self-check). NEVER return/echo the private key — only the public key.
    const verified = trustedKey ? verifyPassport(s.passport, trustedKey) : verifyPassport(s.passport)
    return reply.send({ passport: s.passport, verified, ...(trustedKey ? { publicKey: trustedKey } : {}) })
  })

  // BUILD PROVENANCE ATTESTATION (Move 3): a portable, SLSA/in-toto-aligned export wrapping the
  // SIGNED passport with the build's gate/verification context — the artifact a user hands a client.
  // Owner-scoped + read-only (mirrors /passport); 404 when no signed passport exists. ?format=md
  // downloads a human-readable rendering; default returns JSON. Mints nothing, holds no capability.
  app.get<{ Params: { id: string }; Querystring: { format?: string } }>('/sessions/:id/attestation', async (req, reply) => {
    const id = req.params.id
    const s = await accessibleSession(req, id)
    if (!s) return notFound(reply, id)
    const att = buildAttestation(s)
    if (!att) return reply.code(404).send({ error: 'no attestation — this build has no signed passport', code: 'NoAttestation' })
    if (req.query.format === 'md') {
      return reply
        .type('text/markdown; charset=utf-8')
        .header('content-disposition', `attachment; filename="akis-attestation-${id.replace(/[^A-Za-z0-9._-]/g, '_')}.md"`)
        .send(attestationMarkdown(att))
    }
    return reply.send(att)
  })

  // DURABLE AUDIT TRAIL (Move 3a): the build's chronological event ledger, owner-scoped. Reads the
  // restart-durable audit_events table when present; falls back to the in-memory bus replay
  // otherwise (still owner-scoped). Read-only observability — no capability, mints nothing.
  app.get<{ Params: { id: string } }>('/sessions/:id/audit', async (req, reply) => {
    const id = req.params.id
    const s = await accessibleSession(req, id)
    if (!s) return notFound(reply, id)
    if (deps.auditStore) {
      const entries = await deps.auditStore.listBySession(id)
      return reply.send({ durable: true, entries })
    }
    const { events } = services.bus.replaySince(id, 0)
    return reply.send({ durable: false, entries: events.map(e => ({ seq: e.seq, kind: e.event.kind, payload: e.event })) })
  })

  // EXTERNAL WRITES (Jira/Confluence via MCP) — gate-safe: an agent/user PROPOSES; the write executes
  // ONLY after a HUMAN confirm (digest-bound + action-allow-listed via the external-write gate). The
  // model is never autonomous over an outward side effect. All owner-scoped.
  app.get<{ Params: { id: string } }>('/sessions/:id/external-writes', async (req, reply) => {
    const s = await accessibleSession(req, req.params.id)
    if (!s) return notFound(reply, req.params.id)
    return reply.send({ writes: s.externalWrites ?? [] })
  })

  // Record a proposal (no execution). Returns the content digest the human must confirm.
  app.post<{ Params: { id: string }; Body: { provider?: string; action?: string; summary?: string; target?: Record<string, unknown>; payload?: Record<string, unknown> } }>('/sessions/:id/external-writes', async (req, reply) => {
    const s = await accessibleSession(req, req.params.id)
    if (!s) return notFound(reply, req.params.id)
    const b = req.body ?? {}
    if (!b.action || !isAllowedExternalWriteAction(b.action)) return reply.code(400).send({ error: 'action is not on the external-write allow-list', code: 'BadAction' })
    const proposal: ExternalWriteRecord = {
      id: randomUUID(), provider: b.provider ?? 'atlassian', action: b.action,
      summary: (b.summary ?? b.action).slice(0, 200), target: b.target ?? {}, payload: b.payload ?? {},
      status: 'proposed', proposedAt: new Date().toISOString(),
    }
    const next = [...(s.externalWrites ?? []), proposal].slice(-EXTERNAL_WRITES_MAX)
    await services.store.update(s.id, { externalWrites: next }, s.version)
    // The digest binds provider/action/target/payload only (the gate's strict provider union; the
    // record keeps provider as a widenable string for forward-compat).
    const digest = digestExternalWrite({ provider: proposal.provider as ExternalWriteProposal['provider'], action: proposal.action, target: proposal.target, payload: proposal.payload })
    return reply.send({ id: proposal.id, digest, summary: proposal.summary })
  })

  // Confirm + EXECUTE a proposal (the only path that writes externally). Mints the digest-bound,
  // allow-listed ApprovedExternalWrite, runs it through the user's per-provider MCP transport.
  // An external write is NON-idempotent (createPage/createJiraIssue → a duplicate page/issue).
  // `status !== 'proposed'` rejects a SEQUENTIAL replay, but two CONCURRENT confirms both read
  // status:'proposed' before either persists → a DOUBLE external write. The per-writeId in-flight
  // guard closes that window — the same pattern as the push `confirming` Set below
  // (gate-keeper HIGH, 2026-06-07).
  const confirmingWrites = new Set<string>()
  // Version-RESILIENT, status-GUARDED patch of one external-write record. Re-reads the latest version
  // (a live chat turn / a second propose bumps it during a multi-second confirm) and retries only on
  // an optimistic-lock conflict. Applies the patch ONLY when the record is still at `from` — so a
  // crash/retry can never re-drive a transition that already happened (at-most-once). Returns whether
  // it wrote.
  const patchExternalWrite = async (sessionId: string, writeId: string, from: ExternalWriteRecord['status'], to: ExternalWriteRecord): Promise<boolean> => {
    for (let attempt = 0; ; attempt++) {
      const cur = await services.store.get(sessionId)
      if (!cur) return false // session vanished mid-confirm
      const rec = (cur.externalWrites ?? []).find(w => w.id === writeId)
      if (!rec || rec.status !== from) return false // already moved on (concurrent/retry) — do nothing
      const next = (cur.externalWrites ?? []).map(w => (w.id === writeId ? to : w))
      try { await services.store.update(sessionId, { externalWrites: next }, cur.version); return true }
      catch (e) {
        if (attempt >= 5 || !/version conflict/.test(e instanceof Error ? e.message : '')) throw e
        // else: re-read + retry the optimistic update.
      }
    }
  }
  app.post<{ Params: { id: string; writeId: string }; Body: { digest?: string } }>('/sessions/:id/external-writes/:writeId/confirm', async (req, reply) => {
    const s = await accessibleSession(req, req.params.id)
    if (!s) return notFound(reply, req.params.id)
    const rec = (s.externalWrites ?? []).find(w => w.id === req.params.writeId)
    if (!rec) return reply.code(404).send({ error: 'no such external-write proposal', code: 'NoProposal' })
    if (rec.status !== 'proposed') return reply.code(409).send({ error: `proposal already ${rec.status}`, code: 'AlreadyResolved' })
    const inflightKey = `${s.id}:${rec.id}`
    if (confirmingWrites.has(inflightKey)) return reply.code(409).send({ error: 'confirm already in progress', code: 'ConfirmInProgress' })
    confirmingWrites.add(inflightKey)
    try {
      const ownerId = await deps.userIdOf?.(req)
      if (!ownerId) return reply.code(401).send({ error: 'unauthorized', code: 'Unauthorized' })
      if (!deps.mcpAuthStore) return reply.code(409).send({ error: 'remote-MCP not configured', code: 'McpUnavailable' })
      const transport = (deps.mcpTransportFor ?? mcpTransportFor)({ userId: ownerId, provider: rec.provider, store: deps.mcpAuthStore, env: deps.env ?? process.env })
      if (!transport) return reply.code(409).send({ error: `not connected to ${rec.provider} — connect it first`, code: 'NotConnected' })
      const proposal: ExternalWriteProposal = { id: rec.id, provider: rec.provider as ExternalWriteProposal['provider'], summary: rec.summary, action: rec.action, target: rec.target, payload: rec.payload }
      const now = (): string => new Date().toISOString()
      // 1. VALIDATE (digest + allow-list) BEFORE any state change or side effect — a mismatch is a
      //    terminal 'failed' (nothing written), recorded resiliently from 'proposed'.
      let token
      try { token = mintApprovedExternalWrite(proposal, req.body?.digest ?? '') }
      catch (e) {
        await transport.close().catch(() => {})
        await patchExternalWrite(s.id, rec.id, 'proposed', { ...rec, status: 'failed', result: e instanceof Error ? e.message : String(e), confirmedAt: now() })
        return reply.send({ ok: false, status: 'failed', result: 'digest or allow-list mismatch' })
      }
      // 2. IN-DOUBT guard (#30): mark 'executing' DURABLY before the outward call, so a crash/retry
      //    between the call and the outcome can NEVER re-execute — a retry reads status 'executing'
      //    (≠ 'proposed') → 409 above. The single 'proposed'→'executing' transition is the at-most-
      //    once gate; if it didn't win (a concurrent confirm already moved it), refuse.
      if (!(await patchExternalWrite(s.id, rec.id, 'proposed', { ...rec, status: 'executing' }))) {
        await transport.close().catch(() => {})
        return reply.code(409).send({ error: 'proposal already resolved', code: 'AlreadyResolved' })
      }
      // 3. Execute exactly once.
      let resolved: ExternalWriteRecord
      try {
        const out = await executeExternalWrite(token, transport, proposal)
        resolved = { ...rec, status: out.ok ? 'executed' : 'failed', result: out.text.slice(0, 500), confirmedAt: now() }
      } catch (e) {
        resolved = { ...rec, status: 'failed', result: e instanceof Error ? e.message : String(e), confirmedAt: now() }
      } finally {
        await transport.close().catch(() => {})
      }
      // 4. Record the outcome (from 'executing'). A crash HERE leaves an honest in-doubt 'executing'
      //    record for manual resolution — never a silent re-execute (the digest/allow-list are unchanged).
      await patchExternalWrite(s.id, rec.id, 'executing', resolved)
      return reply.send({ ok: resolved.status === 'executed', status: resolved.status, result: resolved.result })
    } finally {
      confirmingWrites.delete(inflightKey)
    }
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
  // PUSH is the one NON-idempotent gate action (it can create a repo / open a PR). confirmPush
  // already rejects a SEQUENTIAL re-confirm (status→done→AlreadyPushedError), but two CONCURRENT
  // confirms both read status:awaiting_push_confirm before either persists done → a double push.
  // A narrow per-session in-flight guard closes that window (the FE button is also disabled while
  // busy; this is the server-side backstop). Scoped to confirm only, so it can never interfere with
  // the legitimately-sequential approve→run handoff.
  const confirming = new Set<string>()
  app.post<{ Params: { id: string } }>('/sessions/:id/confirm', action(async id => {
    if (confirming.has(id)) throw new Error('push already in progress')
    confirming.add(id)
    try { return await orchestratorFor(id).confirmPush(id) }
    finally { confirming.delete(id) }
  }))

  // Run control: STOP/CANCEL an in-flight run — a clean TERMINAL abandon (owner-scoped,
  // version-safe via the orchestrator's store update). It refuses from a terminal status
  // (WrongStatusError → 409). NOT a gate bypass: cancel never verifies/ships (see
  // Orchestrator.cancel). The `action` wrapper releases the bound orchestrator on the
  // resulting terminal `cancelled` status.
  app.post<{ Params: { id: string } }>('/sessions/:id/cancel', action(id => orchestratorFor(id).cancel(id)))

  // ── Run-state recovery (owner-scoped, like the gate routes) ──
  // These un-park a NON-structural automatic state; they NEVER bypass a structural gate.
  // Resolve an awaiting_critic_resolution: 'proceed' continues the pipeline (to the spec
  // gate if unapproved, else to the REAL verify + push gates), 'abandon' cancels the run.
  app.post<{ Params: { id: string }; Body: { decision?: string } }>('/sessions/:id/resolve', async (req, reply) => {
    const id = req.params.id
    if (!(await accessibleSession(req, id))) return notFound(reply, id)
    const decision = req.body?.decision
    if (decision !== 'proceed' && decision !== 'abandon') {
      return reply.code(400).send({ error: "decision must be 'proceed' or 'abandon'", code: 'BadRequest' })
    }
    try {
      const r = await orchestratorFor(id).resolveCritic(id, decision)
      if (TERMINAL.has(r.status)) bound.delete(id)
      return reply.send(r)
    } catch (err) { return sendError(reply, err) }
  })
  // Retry a verify_failed run: re-enters the verify step and RE-RUNS REAL verification
  // (mint still needs a genuine ≥1-test pass — no bypass).
  app.post<{ Params: { id: string } }>('/sessions/:id/retry', action(id => orchestratorFor(id).retryVerification(id)))

  // ── Publish to your own server (OCI free-tier) — POST-`done`, OPTIONAL, NON-GATING ──
  // SACRED: publish can never gate, block, or fake verification. It runs ONLY from `done` (the
  // session already passed the push gate); it deploys the session's produced files to the owner's
  // OWN server over SSH and PATCHES a `publish` record via the GENERIC store.update path (NOT a
  // gate method) — the session status is NEVER moved. A deploy FAILURE is an honest 200 report
  // ({ok:false, scrubbed logTail}) that LEAVES status `done`; only a genuine programming error
  // bubbles to sendError. Owner-scoped via accessibleSession (404 non-owner/unknown — which is
  // ALSO what stops uid B from probing whether uid A has a profile).
  app.post<{ Params: { id: string } }>('/sessions/:id/publish', async (req, reply) => {
    const id = req.params.id
    const s = await accessibleSession(req, id)
    if (!s) return notFound(reply, id)
    // Publish is unavailable when the store/seam isn't wired (e.g. test boot without it).
    if (!deps.publishProfiles || !deps.publisher) {
      return reply.code(409).send({ error: 'publish is not configured on this server', code: 'NoPublishProfileError' })
    }
    try {
      // 409 — only a `done` session may publish (it already passed the push gate). The same
      // WrongStatusError the orchestrator uses, mapped to 409 verbatim via CONFLICT_ERRORS.
      if (s.status !== 'done') throw new WrongStatusError('publish', s.status)
      const ownerId = await deps.userIdOf?.(req)
      // A USABLE profile is required (decryptable — a rotated master reads as no-profile,
      // fail-closed, mirroring GitHubConnectionStore.status). Resolve under the OWNER's id.
      const profile = ownerId ? deps.publishProfiles.getProfile(ownerId) : undefined
      if (!profile) throw new NoPublishProfileError()
      const files = s.code?.files ?? []
      // Deploy. The publisher returns an honest PublishRecord; expected failures DO NOT throw.
      const record = await deps.publisher({ files, profile })
      // Persist the record on the GENERIC patch path — additive + non-gate (exactly like
      // testEvidence/passport). Status is untouched: a failed publish leaves the build `done`.
      const updated = await services.store.update(id, { publish: record }, s.version)
      return reply.send(updated)
    } catch (err) { return sendError(reply, err) }
  })

  // Batch event log: the retained {seq,event}[] for a session. The FE fetches this on
  // an SSE `reset` to rebuild its live view from the authoritative history (the SSE
  // stream alone can't, after a buffer drop), then resumes live from head (F2-AC12).
  app.get<{ Params: { id: string } }>('/sessions/:id/log', async (req, reply) => {
    const id = req.params.id
    const stored = await services.store.get(id)
    if (stored?.ownerId && (await deps.userIdOf?.(req)) !== stored.ownerId) return notFound(reply, id) // owner-scope: no cross-user log read
    if (services.bus.head(id) === 0 && !stored) return notFound(reply, id)
    const { events, dropped } = services.bus.replaySince(id, 0)
    // `truncated` = the buffer already evicted head events (a >cap-event session), so
    // this log is a tail, not the full history — the client can surface that honestly.
    return reply.send({ events, head: services.bus.head(id), truncated: dropped })
  })

  // CLIENT-FACING TRUST REPORT (GTM §8's first commercial build item): a pure PROJECTION of
  // the facts this session already earned through the gates — structured JSON by default,
  // a self-contained Markdown artifact with ?format=md (what an agency sends a client).
  // Owner-scoped like /log; grants nothing (verified can only mirror REAL evidence, and a
  // simulated/demo run is loudly labeled SIMULATED).
  app.get<{ Params: { id: string }; Querystring: { format?: string } }>('/sessions/:id/report', async (req, reply) => {
    const id = req.params.id
    const s = await accessibleSession(req, id)
    if (!s) return notFound(reply, id)
    const { events } = services.bus.replaySince(id, 0)
    const report = buildTrustReport(s, events)
    if (req.query.format === 'md') {
      return reply
        .type('text/markdown; charset=utf-8')
        .header('content-disposition', `attachment; filename="trust-report-${id.replace(/[^A-Za-z0-9._-]/g, '_')}.md"`)
        .send(renderTrustReportMarkdown(report))
    }
    return reply.send(report)
  })

  // Resumable SSE stream (CF1 + CF5 / F2-AC12).
  app.get<{ Params: { id: string }; Querystring: { lastEventId?: string } }>(
    '/sessions/:id/events',
    async (req, reply) => {
      const id = req.params.id
      const stored = await services.store.get(id)
      // Owner-scope: a non-owner cannot stream someone else's owned session (404 before hijack).
      if (stored?.ownerId && (await deps.userIdOf?.(req)) !== stored.ownerId) return notFound(reply, id)
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
