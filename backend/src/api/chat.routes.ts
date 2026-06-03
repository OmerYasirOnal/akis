import type { FastifyInstance } from 'fastify'
import type { LlmProvider } from '../agent/LlmProvider.js'
import { sseControl } from './sse.js'

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
  'That `akis-spec` block triggers a one-click Build card in the UI (the user reviews it, downloads it, and approves to run the pipeline).',
  'So NEVER tell the user to copy-paste the spec or to retype it in a box — the akis-spec block IS the Build action. Put only the spec inside the block; keep any chatter outside it.',
  'Never claim to have built or run anything yourself in this chat — the Build flow does that.',
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

export interface ChatDeps { provider: LlmProvider }

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
  app.post<{ Body: { message?: unknown; history?: unknown } }>('/api/chat', async (req, reply) => {
    const message = isStr(req.body?.message) ? req.body.message.trim() : ''
    if (!message) return reply.code(400).send({ error: 'message required', code: 'BadRequest' })
    const messages = assembleMessages(message, req.body?.history)
    try {
      const res = await deps.provider.chat({ system: AKIS_PERSONA, messages, maxTokens: CHAT_MAX_TOKENS })
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
  app.post<{ Body: { message?: unknown; history?: unknown } }>('/api/chat/stream', async (req, reply) => {
    const message = isStr(req.body?.message) ? req.body.message.trim() : ''
    if (!message) return reply.code(400).send({ error: 'message required', code: 'BadRequest' })
    const messages = assembleMessages(message, req.body?.history)
    const chatReq = { system: AKIS_PERSONA, messages, maxTokens: CHAT_MAX_TOKENS }

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
      if (deps.provider.chatStream) {
        res = await deps.provider.chatStream(chatReq, onDelta)
      } else {
        res = await deps.provider.chat(chatReq)
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
