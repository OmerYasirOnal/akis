import type { FastifyInstance } from 'fastify'
import type { LlmProvider } from '../agent/LlmProvider.js'

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
 * POST /api/chat — a free-form conversation WITH AKIS (distinct from the build flow).
 * Stateless: the client sends the recent history; AKIS replies in persona via the
 * same provider that powers the agents. Caps history to bound token use.
 */
export function registerChatRoutes(app: FastifyInstance, deps: ChatDeps): void {
  app.post<{ Body: { message?: unknown; history?: unknown } }>('/api/chat', async (req, reply) => {
    const message = isStr(req.body?.message) ? req.body.message.trim() : ''
    if (!message) return reply.code(400).send({ error: 'message required', code: 'BadRequest' })
    const rawHistory = Array.isArray(req.body?.history) ? req.body!.history : []
    const history = rawHistory
      .filter((m): m is { role: string; content: string } => !!m && typeof m === 'object' && isStr((m as { role?: unknown }).role) && isStr((m as { content?: unknown }).content))
      .filter(m => ROLES.has(m.role))
      .slice(-MAX_HISTORY)
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))
    try {
      const res = await deps.provider.chat({ system: AKIS_PERSONA, messages: alternating([...history, { role: 'user', content: message }]), maxTokens: CHAT_MAX_TOKENS })
      // Return the reply verbatim (trimmed). An empty reply is surfaced HONESTLY as '' so the
      // UI can show a real "empty reply" notice — never disguised as a friendly '…' answer.
      return reply.send({ reply: (res.text ?? '').trim() })
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'chat failed', code: 'ProviderError' })
    }
  })
}
