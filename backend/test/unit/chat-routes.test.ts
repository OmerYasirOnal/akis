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

  it('caps and sanitizes history before sending it to the provider', async () => {
    const p = provider(() => ({ text: 'ok' }))
    const a = await app(p)
    const history = [
      { role: 'system', content: 'ignored bad role' },
      ...Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` })),
    ]
    await a.inject({ method: 'POST', url: '/api/chat', payload: { message: 'final', history } })
    // history is capped (MAX_HISTORY) + the final user message; no 'system' role survives.
    expect(p.last!.messages.every(m => m.role === 'user' || m.role === 'assistant')).toBe(true)
    expect(p.last!.messages.at(-1)).toEqual({ role: 'user', content: 'final' })
    await a.close()
  })
})
