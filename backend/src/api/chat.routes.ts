import type { FastifyInstance } from 'fastify'
import type { LlmProvider } from '../agent/LlmProvider.js'
import { sseControl } from './sse.js'
import { CATALOG, type ProviderId } from '../agent/providers/catalog.js'
import { createProvider, ProviderConfigError, type KeyLookup } from '../agent/providers/createProvider.js'

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
  app.post<{ Body: { message?: unknown; history?: unknown; provider?: unknown; model?: unknown; effort?: unknown } }>('/api/chat', async (req, reply) => {
    const message = isStr(req.body?.message) ? req.body.message.trim() : ''
    if (!message) return reply.code(400).send({ error: 'message required', code: 'BadRequest' })
    const provider = isStr(req.body?.provider) ? req.body.provider.trim() || undefined : undefined
    const model = isStr(req.body?.model) ? req.body.model.trim() || undefined : undefined
    const effort = isStr(req.body?.effort) ? req.body.effort.trim() || undefined : undefined
    const messages = assembleMessages(message, req.body?.history)
    // Resolve the per-request provider FIRST so a bad provider/model/key is a clean 4xx (400
    // BadRequest / 400 NoKey) — never a 502. Absent overrides → deps.provider, byte-identical.
    let resolved: LlmProvider
    try {
      resolved = resolvePerRequestProvider(deps.provider, provider, model, deps.env, deps.keyStore)
    } catch (err) {
      if (err instanceof ChatRequestError) return reply.code(err.status).send({ error: err.message, code: err.code })
      throw err
    }
    try {
      const res = await resolved.chat({ system: AKIS_PERSONA, messages, maxTokens: mapEffortToTokens(effort) })
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
  app.post<{ Body: { message?: unknown; history?: unknown; provider?: unknown; model?: unknown; effort?: unknown } }>('/api/chat/stream', async (req, reply) => {
    const message = isStr(req.body?.message) ? req.body.message.trim() : ''
    if (!message) return reply.code(400).send({ error: 'message required', code: 'BadRequest' })
    const provider = isStr(req.body?.provider) ? req.body.provider.trim() || undefined : undefined
    const model = isStr(req.body?.model) ? req.body.model.trim() || undefined : undefined
    const effort = isStr(req.body?.effort) ? req.body.effort.trim() || undefined : undefined
    const messages = assembleMessages(message, req.body?.history)
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
    const chatReq = { system: AKIS_PERSONA, messages, maxTokens: mapEffortToTokens(effort) }

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
