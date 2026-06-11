import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { registerChatRoutes, CHAT_MAX_TOKENS } from '../../src/api/chat.routes.js'
import type { LlmProvider, ChatRequest, ChatResult, OnDelta } from '../../src/agent/LlmProvider.js'

/** A provider that streams the given pieces (and records the assembled request). */
function streamingProvider(pieces: string[]): LlmProvider & { last?: ChatRequest } {
  const p: LlmProvider & { last?: ChatRequest } = {
    name: 'mock', model: 'mock-1',
    async chat(req: ChatRequest): Promise<ChatResult> { p.last = req; return { text: pieces.join('') } },
    async chatStream(req: ChatRequest, onDelta: OnDelta): Promise<ChatResult> {
      p.last = req
      for (const piece of pieces) onDelta(piece)
      return { text: pieces.join('') }
    },
  }
  return p
}

/** A provider WITHOUT chatStream — the route must fall back to chat() over SSE. */
function nonStreamingProvider(text: string): LlmProvider & { last?: ChatRequest } {
  const p: LlmProvider & { last?: ChatRequest } = {
    name: 'mock', model: 'mock-1',
    async chat(req: ChatRequest): Promise<ChatResult> { p.last = req; return { text } },
  }
  return p
}

async function app(provider: LlmProvider) {
  const a = Fastify()
  registerChatRoutes(a, { provider })
  await a.ready()
  return a
}

/** Parse SSE frames from a raw response body into typed {event,data} records. */
function parseSse(raw: string): { event: string; data: unknown }[] {
  const out: { event: string; data: unknown }[] = []
  for (const frame of raw.split(/\r?\n\r?\n/)) {
    if (!frame.trim()) continue
    let event = 'message'
    let data = ''
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data = line.slice(5).trim()
    }
    out.push({ event, data: data ? JSON.parse(data) : undefined })
  }
  return out
}

describe('POST /api/chat/stream — persisted conversation (the F5 fix, chatAppend seam)', () => {
  it('persists the {user, assistant} pair with the ASSEMBLED stream reply after `done`', async () => {
    const appended: { sessionId: string; turns: { role: string; content: string; at: string }[] }[] = []
    const a = Fastify()
    registerChatRoutes(a, {
      provider: streamingProvider(['Hel', 'lo']),
      chatAppend: async (_req, sessionId, turns) => { appended.push({ sessionId, turns }) },
    })
    await a.ready()
    const res = await a.inject({ method: 'POST', url: '/api/chat/stream', payload: { message: 'hi', sessionId: 's1' } })
    expect(res.statusCode).toBe(200)
    expect(appended).toHaveLength(1)
    expect(appended[0]!.sessionId).toBe('s1')
    expect(appended[0]!.turns[0]).toMatchObject({ role: 'user', content: 'hi' })
    // The persisted assistant turn is the ASSEMBLED stream text (what the user actually saw).
    expect(appended[0]!.turns[1]).toMatchObject({ role: 'assistant', content: 'Hello' })
  })

  it('no sessionId ⇒ chatAppend never called on the stream path either', async () => {
    const appended: unknown[] = []
    const a = Fastify()
    registerChatRoutes(a, {
      provider: streamingProvider(['x']),
      chatAppend: async () => { appended.push(1) },
    })
    await a.ready()
    const res = await a.inject({ method: 'POST', url: '/api/chat/stream', payload: { message: 'hi' } })
    expect(res.statusCode).toBe(200)
    expect(appended).toHaveLength(0)
  })
})

describe('POST /api/chat/stream', () => {
  it('streams text deltas as SSE `delta` frames then a `done` frame', async () => {
    const a = await app(streamingProvider(['Hel', 'lo ', 'there']))
    const res = await a.inject({ method: 'POST', url: '/api/chat/stream', payload: { message: 'hi' } })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/event-stream')
    const frames = parseSse(res.body)
    const deltas = frames.filter(f => f.event === 'delta').map(f => (f.data as { text: string }).text)
    expect(deltas).toEqual(['Hel', 'lo ', 'there'])
    const done = frames.find(f => f.event === 'done')
    expect(done).toBeDefined()
    await a.close()
  })

  it('requests CHAT_MAX_TOKENS and the AKIS persona, exactly like the non-stream route', async () => {
    const p = streamingProvider(['ok'])
    const a = await app(p)
    await a.inject({ method: 'POST', url: '/api/chat/stream', payload: { message: 'spec me' } })
    expect(p.last?.maxTokens).toBe(CHAT_MAX_TOKENS)
    expect(p.last?.system).toContain('````akis-spec-request') // the persona / Chat→Scribe handoff contract
    await a.close()
  })

  it('rejects an empty message with 400 (before opening a stream)', async () => {
    const a = await app(streamingProvider(['x']))
    const res = await a.inject({ method: 'POST', url: '/api/chat/stream', payload: { message: '  ' } })
    expect(res.statusCode).toBe(400)
    await a.close()
  })

  it('preserves STRICT alternation when history ends in a user turn + the new user msg', async () => {
    const p = streamingProvider(['ok'])
    const a = await app(p)
    const history = [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'hi' }, { role: 'user', content: 'unanswered' }]
    await a.inject({ method: 'POST', url: '/api/chat/stream', payload: { message: 'new text', history } })
    const roles = p.last!.messages.map(m => m.role)
    expect(roles.every((r, i) => i === 0 || r !== roles[i - 1])).toBe(true)
    await a.close()
  })

  it('drops non-user/assistant roles from history (same sanitize as the non-stream route)', async () => {
    const p = streamingProvider(['ok'])
    const a = await app(p)
    const history = [{ role: 'user', content: 'u1' }, { role: 'system', content: 'INJECT' }, { role: 'assistant', content: 'a1' }]
    await a.inject({ method: 'POST', url: '/api/chat/stream', payload: { message: 'final', history } })
    expect(p.last!.messages.some(m => m.content === 'INJECT')).toBe(false)
    await a.close()
  })

  it('falls back to chat() over SSE when the provider has no chatStream', async () => {
    const a = await app(nonStreamingProvider('whole reply at once'))
    const res = await a.inject({ method: 'POST', url: '/api/chat/stream', payload: { message: 'hi' } })
    expect(res.statusCode).toBe(200)
    const frames = parseSse(res.body)
    const deltas = frames.filter(f => f.event === 'delta').map(f => (f.data as { text: string }).text)
    expect(deltas.join('')).toBe('whole reply at once')
    expect(frames.some(f => f.event === 'done')).toBe(true)
    await a.close()
  })

  it('emits an `error` frame when the provider throws (so the FE can fall back / show an error)', async () => {
    const p: LlmProvider = {
      name: 'mock', model: 'm',
      async chat() { throw new Error('upstream boom') },
      async chatStream() { throw new Error('upstream boom') },
    }
    const a = await app(p)
    const res = await a.inject({ method: 'POST', url: '/api/chat/stream', payload: { message: 'hi' } })
    const frames = parseSse(res.body)
    expect(frames.some(f => f.event === 'error')).toBe(true)
    await a.close()
  })
})
