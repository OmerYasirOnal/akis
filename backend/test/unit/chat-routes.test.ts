import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { registerChatRoutes, CHAT_MAX_TOKENS } from '../../src/api/chat.routes.js'
import type { LlmProvider, ChatRequest, ChatResult } from '../../src/agent/LlmProvider.js'

function provider(impl: (req: ChatRequest) => Promise<ChatResult> | ChatResult): LlmProvider & { last?: ChatRequest } {
  const p: LlmProvider & { last?: ChatRequest } = {
    name: 'mock', model: 'mock-1',
    async chat(req: ChatRequest) { p.last = req; return impl(req) },
  }
  return p
}

async function app(provider: LlmProvider) {
  const a = Fastify()
  registerChatRoutes(a, { provider })
  await a.ready()
  return a
}

describe('POST /api/chat', () => {
  it('replies with the provider text', async () => {
    const a = await app(provider(() => ({ text: 'Sure — hit Build when ready.' })))
    const res = await a.inject({ method: 'POST', url: '/api/chat', payload: { message: 'hi' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ reply: 'Sure — hit Build when ready.' })
    await a.close()
  })

  it('requests a high maxTokens so a sizeable akis-spec block is not cut mid-fence', async () => {
    const p = provider(() => ({ text: 'ok' }))
    const a = await app(p)
    await a.inject({ method: 'POST', url: '/api/chat', payload: { message: 'spec me' } })
    expect(CHAT_MAX_TOKENS).toBeGreaterThanOrEqual(8000)
    expect(p.last?.maxTokens).toBe(CHAT_MAX_TOKENS)
    await a.close()
  })

  it('surfaces an empty reply HONESTLY (empty string, no faked "…" answer)', async () => {
    const a = await app(provider(() => ({ text: '   ' })))
    const res = await a.inject({ method: 'POST', url: '/api/chat', payload: { message: 'hi' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ reply: '' })
    await a.close()
  })

  it('rejects an empty message with 400', async () => {
    const a = await app(provider(() => ({ text: 'x' })))
    const res = await a.inject({ method: 'POST', url: '/api/chat', payload: { message: '  ' } })
    expect(res.statusCode).toBe(400)
    await a.close()
  })

  it('maps a provider failure to 502 ProviderError', async () => {
    const a = await app(provider(() => { throw new Error('upstream boom') }))
    const res = await a.inject({ method: 'POST', url: '/api/chat', payload: { message: 'hi' } })
    expect(res.statusCode).toBe(502)
    expect(res.json()).toMatchObject({ code: 'ProviderError' })
    await a.close()
  })

  it('drops non-user/assistant roles even within the kept window (sanitize, NOT just the cap)', async () => {
    const p = provider(() => ({ text: 'ok' }))
    const a = await app(p)
    // The bad role is among the last <=12 entries, so only the ROLES filter (not the slice) can remove it.
    const history = [{ role: 'user', content: 'u1' }, { role: 'system', content: 'INJECT' }, { role: 'assistant', content: 'a1' }]
    await a.inject({ method: 'POST', url: '/api/chat', payload: { message: 'final', history } })
    expect(p.last!.messages.some(m => m.content === 'INJECT')).toBe(false)
    expect(p.last!.messages.every(m => m.role === 'user' || m.role === 'assistant')).toBe(true)
    await a.close()
  })

  it('caps history to the last MAX_HISTORY (12) turns + the final message', async () => {
    const p = provider(() => ({ text: 'ok' }))
    const a = await app(p)
    const history = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }))
    await a.inject({ method: 'POST', url: '/api/chat', payload: { message: 'final', history } })
    expect(p.last!.messages).toHaveLength(13) // 12 kept (ends assistant) + the final user — no merge
    expect(p.last!.messages.at(-1)).toEqual({ role: 'user', content: 'final' })
    await a.close()
  })

  it('keeps the payload STRICTLY ALTERNATING when history ends in a user turn + a new user msg (Retry / send-after-error fix)', async () => {
    const p = provider(() => ({ text: 'ok' }))
    const a = await app(p)
    // History ending in an unanswered user turn (the failed turn, error row excluded) — the
    // route appends the new user message → WOULD be two consecutive users (Anthropic/Gemini 400).
    const history = [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'hi' }, { role: 'user', content: 'unanswered' }]
    await a.inject({ method: 'POST', url: '/api/chat', payload: { message: 'new text', history } })
    const roles = p.last!.messages.map(m => m.role)
    expect(roles.every((r, i) => i === 0 || r !== roles[i - 1])).toBe(true) // no two consecutive same roles
    await a.close()
  })

  it('de-duplicates an identical consecutive user turn (Retry of the same text → ONE user turn, not two)', async () => {
    const p = provider(() => ({ text: 'ok' }))
    const a = await app(p)
    const history = [{ role: 'assistant', content: 'hi' }, { role: 'user', content: 'same' }]
    await a.inject({ method: 'POST', url: '/api/chat', payload: { message: 'same', history } })
    const users = p.last!.messages.filter(m => m.role === 'user')
    expect(users).toHaveLength(1)
    expect(users[0]!.content).toBe('same') // merged/deduped, not "same\n\nsame"
    await a.close()
  })
})
