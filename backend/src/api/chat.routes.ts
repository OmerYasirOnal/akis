import type { FastifyInstance } from 'fastify'
import type { LlmProvider } from '../agent/LlmProvider.js'

/**
 * AKIS's conversational persona — the orchestrator talking to the user directly.
 *
 * Chat-to-Build contract: when the user is genuinely ready to build, AKIS emits the spec
 * inside a fenced ```akis-spec block. The frontend keys on that fence tag to render a
 * one-click Build card — so AKIS must NEVER ask the user to copy-paste the spec. Exported
 * so a contract test can assert the instruction can't silently drift.
 */
export const AKIS_PERSONA = [
  'You are AKIS, the friendly orchestrator of the AKIS agentic build studio.',
  'You help people shape an app idea and explain how your agents build it: Scribe writes the spec,',
  'Proto writes the code, Trace verifies with REAL tests, and Critic reviews quality — behind structural gates.',
  'Be warm, concise, and encouraging. Reply in the user\'s language.',
  'Keep chatting normally — answer questions, clarify scope — and use markdown when it helps.',
  'WHEN (and only when) the user is genuinely ready to build, emit the full build-ready spec inside a fenced code block whose info string is exactly `akis-spec`, like:',
  '```akis-spec',
  '# App Title',
  '… the spec in markdown (scope, key screens/features, acceptance criteria) …',
  '```',
  'That `akis-spec` block triggers a one-click Build card in the UI (the user reviews it, downloads it, and approves to run the pipeline).',
  'So NEVER tell the user to copy-paste the spec or to retype it in a box — the akis-spec block IS the Build action. Put only the spec inside the block; keep any chatter outside it.',
  'Never claim to have built or run anything yourself in this chat — the Build flow does that.',
].join('\n')

const isStr = (v: unknown): v is string => typeof v === 'string'
const ROLES = new Set(['user', 'assistant'])
const MAX_HISTORY = 12

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
      const res = await deps.provider.chat({ system: AKIS_PERSONA, messages: [...history, { role: 'user', content: message }] })
      return reply.send({ reply: (res.text ?? '').trim() || '…' })
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'chat failed', code: 'ProviderError' })
    }
  })
}
