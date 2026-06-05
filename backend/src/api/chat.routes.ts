import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { SessionState } from '@akis/shared'
import { isVerified } from '@akis/shared'
import type { LlmProvider } from '../agent/LlmProvider.js'
import { sseControl } from './sse.js'
import { CATALOG, type ProviderId } from '../agent/providers/catalog.js'
import { createProvider, ProviderConfigError, type KeyLookup } from '../agent/providers/createProvider.js'
import type { UsageStorePort } from '../usage/UsageStore.js'
import { checkQuota, ANON_OWNER, type QuotaPolicy } from '../usage/quota.js'

/**
 * AKIS's conversational persona — the orchestrator talking to the user directly.
 *
 * Chat-to-Build contract: when the user is genuinely ready to build, AKIS emits the spec
 * inside a FOUR-backtick ````akis-spec fenced block (four so the spec body can itself
 * contain ordinary ```code examples without closing early). The frontend keys on that
 * fence tag to render a one-click Build card — so AKIS must NEVER ask the user to
 * copy-paste the spec. Exported so a contract test can assert the instruction can't drift.
 */
export const AKIS_PERSONA = [
  'You are AKIS, the friendly orchestrator of the AKIS agentic build studio.',
  'You help people shape an app idea and explain how your agents build it: Scribe writes the spec,',
  'Proto writes the code, Trace verifies with REAL tests, and Critic reviews quality — behind structural gates.',
  'Be warm, concise, and encouraging. Reply in the user\'s language.',
  'Keep chatting normally — answer questions, clarify scope — and use markdown when it helps.',
  'WHEN (and only when) the user is genuinely ready to build, emit the full build-ready spec inside a code block fenced with FOUR backticks whose info string is exactly `akis-spec`, like:',
  '````akis-spec',
  '# App Title',
  '… the spec in markdown (scope, key screens/features, acceptance criteria; ordinary ```code``` examples inside are fine) …',
  '````',
  'Use four backticks for that fence so any ```code blocks in the spec do not close it early.',
  'That `akis-spec` block renders a one-click "Approve & Build" spec card in the UI — the user reviews it and approves it to run the pipeline behind the structural gates.',
  'There is NO separate "Build" button and no idea box: the user starts the build ONLY by approving the spec card you produce, so describe it that way (e.g. "approve the spec to build it") — never tell them to "press Build". And NEVER tell the user to copy-paste the spec or retype it in a box; the akis-spec block IS the build action. Put only the spec inside the block; keep any chatter outside it.',
  'Never claim to have built or run anything yourself in this chat — the Build flow does that.',
  'When you have been given the CURRENT BUILD context below and the user asks to CHANGE the current app (e.g. "make the button red", "add a settings page"), do NOT claim you changed it — you cannot edit the app from this chat. Instead, emit a FRESH FULL `akis-spec` block describing the EDITED app (the prior spec PLUS the requested change, written whole — not a diff), so the user can approve it to run an edit build. The edit happens only when they approve that card.',
  'When your reply asks the user a question or offers choices (e.g. tweaks, options, next steps), you MAY end the reply with a fenced block whose info string is exactly `akis-suggest`, containing 2–4 SHORT tappable quick-replies (one per line, ≤6 words each), like:',
  '```akis-suggest',
  '- Yes, build it',
  '- Change the color scheme',
  '```',
  'Each line becomes a chip the user taps to send that exact text — so phrase each as something the user would say. Put ONLY suggestions inside the block; keep your prose outside it. Omit the block entirely when there is no natural choice to offer.',
].join('\n')

const isStr = (v: unknown): v is string => typeof v === 'string'
const ROLES = new Set(['user', 'assistant'])
const MAX_HISTORY = 12

type ChatMsg = { role: 'user' | 'assistant'; content: string }

/**
 * Collapse consecutive same-role turns so the payload is STRICTLY ALTERNATING — the Anthropic
 * (default) + Gemini Messages APIs reject two consecutive `user` (or `assistant`) turns with a
 * 400. This happens whenever the client's history ends in an unanswered `user` turn (a failed
 * turn whose error row is excluded from history) and we then append the new `user` message, or
 * on a Retry that re-sends the same text. Identical adjacent content is de-duplicated (the
 * Retry case); distinct content is joined with a blank line (an unanswered turn + the new one).
 */
export function alternating(messages: ChatMsg[]): ChatMsg[] {
  const out: ChatMsg[] = []
  for (const m of messages) {
    const last = out[out.length - 1]
    if (last && last.role === m.role) last.content = last.content === m.content ? last.content : `${last.content}\n\n${m.content}`
    else out.push({ ...m })
  }
  return out
}

/**
 * Token budget for an AKIS chat turn. Generous (8k) so a sizeable build-ready `akis-spec`
 * block is emitted in full — a truncated reply would cut the spec mid-fence, leaving the UI
 * unable to detect/promote it to a Build card. (The agents have their own budgets; this is
 * only the conversational persona.)
 */
export const CHAT_MAX_TOKENS = 8192

/**
 * Effort → maxTokens for a CHAT turn (the "effort level" picker). The three named tiers
 * map to a token budget; `balanced` is the default and equals CHAT_MAX_TOKENS so an
 * absent/invalid effort keeps the EXACT byte-identical budget chat uses today (no drift).
 *
 * FAIL-OPEN (not fail-closed): an unknown/misspelled effort silently degrades to
 * `balanced` rather than 400ing — an invalid effort is harmless (it only sizes the
 * reply), so the conversation must never break over a typo. (Contrast provider/model,
 * which 400 because a wrong provider would talk to the wrong API or leak the wrong key.)
 */
export const EFFORT_TOKENS = { fast: 2048, balanced: 8192, deep: 16384 } as const
export type Effort = keyof typeof EFFORT_TOKENS

export function mapEffortToTokens(effort: string | undefined): number {
  switch (effort?.toLowerCase()) {
    case 'fast': return EFFORT_TOKENS.fast
    case 'deep': return EFFORT_TOKENS.deep
    default: return EFFORT_TOKENS.balanced // 'balanced' OR absent/invalid → the chat default
  }
}

/**
 * The chat route can resolve a DIFFERENT provider/model PER REQUEST (the model picker),
 * so it needs the same env + KeyStore createProvider consults. Absent both, every request
 * uses `deps.provider` unchanged (byte-identical to before the picker existed).
 *
 * SACRED: these per-request overrides are CHAT-ONLY. They never touch builds — the build
 * flow (startSession/workflows) keeps its workflow bindings and never sees {provider,model,
 * effort}. The route resolves a throwaway provider for the single chat turn and discards it.
 */
export interface ChatDeps {
  provider: LlmProvider
  env?: Record<string, string | undefined>
  keyStore?: KeyLookup
  /** Per-user token-quota PRE-CHECK + accounting (multi-tenant safety). When usage + quota are
   *  injected, each chat turn is gated (429 BEFORE the provider call) and its REAL token spend is
   *  accumulated AFTER a successful turn — the SOLE chat-accounting path (chat never emits
   *  agent_end, so no overlap with the bus tap). `ownerOf` resolves the authenticated user
   *  (undefined ⇒ anonymous → the shared __anon__ bucket). Absent ⇒ no check (byte-identical). */
  usage?: UsageStorePort
  quota?: QuotaPolicy
  ownerOf?: (req: FastifyRequest) => Promise<string | undefined>
  /** BUILD-AWARE CHAT (read-only, owner-scoped). Resolves a session the CALLER may access — the
   *  SAME accessibleSession semantics as the gated routes (an owned session is returned only to
   *  its owner; a foreign/unknown id resolves to undefined → the route silently falls back to a
   *  stateless turn). STRICTLY CONVERSATIONAL: this is a read-only `store.get` + ownership compare,
   *  it holds NO orchestrator handle and can never approve/run/verify/push/mint/write — it only
   *  lets the persona SEE the current build (a contents-free snapshot) so it can route an edit
   *  request to a fresh akis-spec card. Absent ⇒ no build-awareness (byte-identical to today). */
  sessionRead?: (req: FastifyRequest, id: string) => Promise<SessionState | undefined>
}

/**
 * Hard char cap on the build-context block as a whole — a single bounded extra SYSTEM block, never
 * history. Spec body is truncated near 600 chars; the file list is paths only (never contents); the
 * total is clamped so a huge spec/file list can never blow the token budget.
 */
export const BUILD_CONTEXT_MAX_CHARS = 2400
const SPEC_BODY_MAX_CHARS = 600
const MAX_CONTEXT_FILES = 40

/** Truncate to `max` chars on a soft boundary, appending an ellipsis marker when cut. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max).trimEnd()}…`
}

/**
 * PURE: build the read-only, owner-scoped, CONTENTS-FREE snapshot of the current build, appended
 * after AKIS_PERSONA as one extra SYSTEM block so the persona can answer questions about — and
 * route edits to — the app the user just built. It leaks NOTHING sensitive:
 *   - spec title + spec body TRUNCATED near 600 chars (never the whole spec),
 *   - the file PATH LIST only — never file CONTENTS,
 *   - the verify OUTCOME (verified / not-yet / simulated), never code/secrets.
 * The whole block is clamped to BUILD_CONTEXT_MAX_CHARS. It mints/writes nothing — it is a string.
 */
export function buildSessionContext(s: SessionState): string {
  const lines: string[] = []
  lines.push('--- CURRENT BUILD (read-only context, do not claim you can edit it directly) ---')
  lines.push(`Idea: ${truncate(s.idea, 200)}`)
  if (s.spec?.title) lines.push(`Spec title: ${truncate(s.spec.title, 200)}`)
  if (s.spec?.body) lines.push(`Spec:\n${truncate(s.spec.body, SPEC_BODY_MAX_CHARS)}`)
  const files = s.code?.files ?? []
  if (files.length) {
    const shown = files.slice(0, MAX_CONTEXT_FILES).map(f => `- ${f.filePath}`)
    const extra = files.length > MAX_CONTEXT_FILES ? `\n- …and ${files.length - MAX_CONTEXT_FILES} more` : ''
    lines.push(`Files (paths only, contents withheld):\n${shown.join('\n')}${extra}`)
  }
  // Verify OUTCOME only (never the token/digest/code): verified, simulated, failed, or not-yet.
  // The branded verifyToken is the gate truth (isVerified); testEvidence is the display mirror that
  // survives in the snapshot and carries the honest `demo` (simulated-run) marker.
  const demo = s.testEvidence?.demo === true
  const testsRun = s.testEvidence?.testsRun
  const testsSuffix = testsRun !== undefined ? ` (${testsRun} tests)` : ''
  const verifyLine = isVerified(s)
    ? `Verification: ${demo ? 'SIMULATED (demo) pass — NOT real verification' : 'verified by real tests'}${testsSuffix}`
    : demo && s.testEvidence?.passed === true
      ? `Verification: SIMULATED (demo) pass — NOT real verification${testsSuffix}`
      : s.testEvidence?.passed === true
        ? `Verification: tests passed${testsSuffix}`
        : s.status === 'verify_failed' || s.testEvidence?.passed === false
          ? 'Verification: tests did NOT pass yet'
          : 'Verification: not yet verified'
  lines.push(verifyLine)
  lines.push('If the user asks to CHANGE this app, emit a fresh full akis-spec block for the edited app (never claim you changed it).')
  return truncate(lines.join('\n'), BUILD_CONTEXT_MAX_CHARS)
}

/** A typed 4xx the route catches and maps to a clean reply.code(status).send({error,code}). */
class ChatRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'ChatRequestError'
  }
}

function isRealProviderId(p: string): p is Exclude<ProviderId, 'mock'> {
  return Object.prototype.hasOwnProperty.call(CATALOG, p)
}

/**
 * Resolve the provider for ONE chat turn from the optional {provider, model} overrides.
 *
 * - Both absent → return `defaultProvider` UNCHANGED (byte-identical; no createProvider call).
 * - `provider` given → validate it is a known CATALOG provider (unknown → 400 BadRequest),
 *   and if `model` is given, validate it belongs to that provider (unknown → 400 BadRequest).
 *   Then build a throwaway provider via createProvider. A missing key surfaces as 400 NoKey
 *   (never 500, never echoes the key); any other ProviderConfigError → 400 BadRequest.
 * - `model` without `provider` → 400 BadRequest (a model alone is ambiguous).
 *
 * Validation is done HERE (against the pure CATALOG, env-independent) BEFORE createProvider,
 * so a bad provider/model is a deterministic 400 even under the test mock — and createProvider
 * is only reached for a genuinely-named override.
 */
export function resolvePerRequestProvider(
  defaultProvider: LlmProvider,
  provider: string | undefined,
  model: string | undefined,
  env?: Record<string, string | undefined>,
  keyStore?: KeyLookup,
): LlmProvider {
  if (!provider && !model) return defaultProvider
  if (!provider) throw new ChatRequestError(400, 'BadRequest', 'model requires a provider')
  if (!isRealProviderId(provider)) throw new ChatRequestError(400, 'BadRequest', `Unknown provider '${provider}'`)
  if (model && !CATALOG[provider].models.some(m => m.id === model)) {
    throw new ChatRequestError(400, 'BadRequest', `Unknown model '${model}' for provider '${provider}'`)
  }
  try {
    // A genuinely-named provider/model: build a throwaway provider for THIS turn only.
    // createProvider is fail-closed — missing key throws ProviderConfigError (never a mock
    // in production), which we translate to a clean 400 NoKey below (never a 500, never the key).
    return createProvider({ provider, ...(model ? { model } : {}), ...(env ? { env } : {}), ...(keyStore ? { keyStore } : {}) })
  } catch (err) {
    if (err instanceof ProviderConfigError) {
      // "No API key" → NoKey; everything else (misconfig) → BadRequest. The message NEVER
      // contains the key (createProvider never logs/embeds it), so it is safe to echo.
      const noKey = /no api key|no key|key found|key configured/i.test(err.message)
      throw new ChatRequestError(400, noKey ? 'NoKey' : 'BadRequest', noKey ? `No API key for provider ${provider}` : err.message)
    }
    throw err
  }
}

/**
 * Sanitize + assemble the provider messages for an AKIS chat turn. SHARED by the
 * stream + non-stream routes so both apply the SAME guards: drop malformed entries,
 * keep only user/assistant roles (no injected `system`), cap to the last MAX_HISTORY
 * turns, append the new user message, then `alternating()` to keep the payload
 * STRICTLY alternating (Anthropic/Gemini 400 on two consecutive same-role turns).
 */
function assembleMessages(message: string, rawHistoryInput: unknown): ChatMsg[] {
  const rawHistory = Array.isArray(rawHistoryInput) ? rawHistoryInput : []
  const history = rawHistory
    .filter((m): m is { role: string; content: string } => !!m && typeof m === 'object' && isStr((m as { role?: unknown }).role) && isStr((m as { content?: unknown }).content))
    .filter(m => ROLES.has(m.role))
    .slice(-MAX_HISTORY)
    .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))
  return alternating([...history, { role: 'user', content: message }])
}

/**
 * POST /api/chat — a free-form conversation WITH AKIS (distinct from the build flow).
 * Stateless: the client sends the recent history; AKIS replies in persona via the
 * same provider that powers the agents. Caps history to bound token use.
 *
 * POST /api/chat/stream is the SSE sibling — same persona/assembly/budget, but text
 * deltas are pushed as they arrive so the UI feels alive. Both routes coexist; the FE
 * uses the stream and falls back to /api/chat on any stream error / unsupported provider.
 */
export function registerChatRoutes(app: FastifyInstance, deps: ChatDeps): void {
  // Per-turn quota PRE-CHECK shared by both routes. Returns the owner key to charge AFTER a
  // successful turn (so the caller accumulates the real spend), or a {blocked} signal carrying
  // the 429 resetAt. When usage/quota are not injected, it never blocks and never charges.
  const quotaGate = async (req: FastifyRequest): Promise<{ blocked: true; resetAt: string } | { blocked: false; ownerKey: string }> => {
    const ownerId = deps.ownerOf ? await deps.ownerOf(req) : undefined
    if (deps.usage && deps.quota) {
      const decision = await checkQuota(deps.usage, deps.quota, ownerId)
      if (!decision.allowed) return { blocked: true, resetAt: decision.resetAt }
    }
    return { blocked: false, ownerKey: ownerId ?? ANON_OWNER }
  }
  // Accumulate a turn's REAL spend (the SOLE chat-accounting path; {0,0}/absent ⇒ no add). Fire-
  // and-forget: a store error is best-effort observability and must never break the reply.
  const chargeUsage = (ownerKey: string, usage: { inTokens: number; outTokens: number } | undefined): void => {
    if (!deps.usage || !usage) return
    const tok = usage.inTokens + usage.outTokens
    if (tok > 0) void Promise.resolve(deps.usage.add(ownerKey, tok)).catch(() => { /* best-effort */ })
  }

  // BUILD-AWARE system prompt for ONE turn. Absent a sessionId (or no sessionRead dep, or a
  // foreign/unknown id) the system is AKIS_PERSONA BYTE-IDENTICAL to today — the build-awareness
  // is purely ADDITIVE and owner-scoped. When the caller owns the session, append the read-only,
  // contents-free context block AFTER the persona. This is the ONLY new read: a string assembly
  // over a read-only store.get — it mints/writes/gates NOTHING (SACRED: strictly conversational).
  const resolveSystem = async (req: FastifyRequest, sessionId: string | undefined): Promise<string> => {
    if (!sessionId || !deps.sessionRead) return AKIS_PERSONA
    const s = await deps.sessionRead(req, sessionId)
    if (!s) return AKIS_PERSONA // foreign/unknown id → stateless fallback (never confirms it exists)
    return `${AKIS_PERSONA}\n\n${buildSessionContext(s)}`
  }

  app.post<{ Body: { message?: unknown; history?: unknown; provider?: unknown; model?: unknown; effort?: unknown; sessionId?: unknown } }>('/api/chat', async (req, reply) => {
    const message = isStr(req.body?.message) ? req.body.message.trim() : ''
    if (!message) return reply.code(400).send({ error: 'message required', code: 'BadRequest' })
    const provider = isStr(req.body?.provider) ? req.body.provider.trim() || undefined : undefined
    const model = isStr(req.body?.model) ? req.body.model.trim() || undefined : undefined
    const effort = isStr(req.body?.effort) ? req.body.effort.trim() || undefined : undefined
    const sessionId = isStr(req.body?.sessionId) ? req.body.sessionId.trim() || undefined : undefined
    const messages = assembleMessages(message, req.body?.history)
    // Per-user token-quota PRE-CHECK — BEFORE resolving/calling any provider (SACRED: a blocked
    // turn never reaches the model). No-op when usage/quota aren't injected (byte-identical).
    const gate = await quotaGate(req)
    if (gate.blocked) return reply.code(429).send({ error: 'token quota exceeded', code: 'QuotaExceeded', resetAt: gate.resetAt })
    // Resolve the per-request provider FIRST so a bad provider/model/key is a clean 4xx (400
    // BadRequest / 400 NoKey) — never a 502. Absent overrides → deps.provider, byte-identical.
    let resolved: LlmProvider
    try {
      resolved = resolvePerRequestProvider(deps.provider, provider, model, deps.env, deps.keyStore)
    } catch (err) {
      if (err instanceof ChatRequestError) return reply.code(err.status).send({ error: err.message, code: err.code })
      throw err
    }
    // Build-aware system (owner-scoped, read-only); absent/foreign sessionId ⇒ AKIS_PERSONA byte-identical.
    const system = await resolveSystem(req, sessionId)
    try {
      const res = await resolved.chat({ system, messages, maxTokens: mapEffortToTokens(effort) })
      // Account the turn's REAL spend (the sole chat path; {0,0}/absent adds nothing).
      chargeUsage(gate.ownerKey, res.usage)
      // Return the reply verbatim (trimmed). An empty reply is surfaced HONESTLY as '' so the
      // UI can show a real "empty reply" notice — never disguised as a friendly '…' answer.
      return reply.send({ reply: (res.text ?? '').trim() })
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'chat failed', code: 'ProviderError' })
    }
  })

  // POST /api/chat/stream — token-by-token SSE. Frames: `delta` ({text}) per chunk,
  // a terminal `done` ({reply}) carrying the full assembled reply (so the FE re-runs
  // spec detection on the authoritative text), or `error` ({message,code}) on failure.
  app.post<{ Body: { message?: unknown; history?: unknown; provider?: unknown; model?: unknown; effort?: unknown; sessionId?: unknown } }>('/api/chat/stream', async (req, reply) => {
    const message = isStr(req.body?.message) ? req.body.message.trim() : ''
    if (!message) return reply.code(400).send({ error: 'message required', code: 'BadRequest' })
    const provider = isStr(req.body?.provider) ? req.body.provider.trim() || undefined : undefined
    const model = isStr(req.body?.model) ? req.body.model.trim() || undefined : undefined
    const effort = isStr(req.body?.effort) ? req.body.effort.trim() || undefined : undefined
    const sessionId = isStr(req.body?.sessionId) ? req.body.sessionId.trim() || undefined : undefined
    const messages = assembleMessages(message, req.body?.history)
    // Per-user token-quota PRE-CHECK — BEFORE reply.hijack() (after hijack only SSE frames can be
    // written, so a 429 would be impossible). Mirrors the existing pre-hijack 4xx for a bad
    // provider/model below: a blocked turn returns a clean JSON 429 (the FE renders it directly,
    // no redundant non-stream fallback). No-op when usage/quota aren't injected (byte-identical).
    const gate = await quotaGate(req)
    if (gate.blocked) return reply.code(429).send({ error: 'token quota exceeded', code: 'QuotaExceeded', resetAt: gate.resetAt })
    // Resolve the per-request provider BEFORE hijacking the socket — a bad provider/model/key
    // must surface as a clean JSON 4xx (the FE then falls back to /api/chat); after reply.hijack()
    // only SSE frames can be written, so a 400 here would be impossible.
    let resolvedProvider: LlmProvider
    try {
      resolvedProvider = resolvePerRequestProvider(deps.provider, provider, model, deps.env, deps.keyStore)
    } catch (err) {
      if (err instanceof ChatRequestError) return reply.code(err.status).send({ error: err.message, code: err.code })
      throw err
    }
    // Build-aware system — resolved BEFORE hijack (the owner-scoped read can't run once we own the
    // socket). Absent/foreign sessionId ⇒ AKIS_PERSONA byte-identical; read-only, mints nothing.
    const system = await resolveSystem(req, sessionId)
    const chatReq = { system, messages, maxTokens: mapEffortToTokens(effort) }

    // Take over the socket and stream on reply.raw (mirrors the agent live stream).
    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // disable proxy buffering so deltas flush immediately
    })
    let aborted = false
    raw.on('close', () => { aborted = true }) // client navigated away — stop pushing
    // An async socket error (EPIPE/ECONNRESET when the client drops mid-stream) with NO listener
    // becomes an UNCAUGHT exception that crashes the process — mirror the agent live stream's guard.
    raw.on('error', () => { aborted = true })
    const safeWrite = (chunk: string): void => { if (!aborted) { try { raw.write(chunk) } catch { aborted = true } } }

    try {
      let full = ''
      const onDelta = (delta: string): void => {
        if (aborted || !delta) return
        full += delta
        safeWrite(sseControl('delta', { text: delta }))
      }
      // Use the streaming seam when the provider supports it; otherwise fall back to
      // chat() and emit its whole reply as a single delta (graceful degradation).
      let res
      if (resolvedProvider.chatStream) {
        res = await resolvedProvider.chatStream(chatReq, onDelta)
      } else {
        res = await resolvedProvider.chat(chatReq)
        onDelta((res.text ?? ''))
      }
      // Account the turn's REAL spend (sole chat path; {0,0}/absent adds nothing). Even when the
      // client dropped (aborted) the tokens were still spent, so charge regardless.
      chargeUsage(gate.ownerKey, res.usage)
      // Prefer the assembled stream text; fall back to the result text (single-shot path).
      const finalReply = (full || res.text || '').trim()
      safeWrite(sseControl('done', { reply: finalReply }))
    } catch (err) {
      safeWrite(sseControl('error', { message: err instanceof Error ? err.message : 'chat failed', code: 'ProviderError' }))
    } finally {
      if (!aborted) { try { raw.end() } catch { /* socket already gone */ } }
    }
  })
}
