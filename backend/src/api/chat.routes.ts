import type { FastifyInstance } from 'fastify'
import type { LlmProvider } from '../agent/LlmProvider.js'

/** AKIS's conversational persona — the orchestrator talking to the user directly. */
const AKIS_PERSONA = [
  'You are AKIS, the friendly orchestrator of the AKIS agentic build studio.',
  'You help people shape an app idea and explain how your agents build it: Scribe writes the spec,',
  'Proto writes the code, Trace verifies with REAL tests, and Critic reviews quality — behind structural gates.',
  'Be warm, concise, and encouraging. Reply in the user\'s language.',
  'If the user clearly wants to build something, briefly confirm the idea and tell them to describe it in the box and press Build.',
  'Never claim to have built or run anything yourself in this chat — the Build flow does that.',
].join(' ')

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
