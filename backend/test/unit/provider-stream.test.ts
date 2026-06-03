import { describe, it, expect } from 'vitest'
import { AnthropicProvider } from '../../src/agent/providers/AnthropicProvider.js'
import { OpenAiCompatibleProvider } from '../../src/agent/providers/OpenAiCompatibleProvider.js'
import { MockProvider } from '../../src/agent/providers/mock/MockProvider.js'

/** Build a streaming Response whose body emits the given SSE frames (one per chunk). */
function sseResponse(frames: string[], status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder()
      for (const f of frames) controller.enqueue(enc.encode(f))
      controller.close()
    },
  })
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } })
}

describe('AnthropicProvider.chatStream', () => {
  it('parses content_block_delta SSE into assembled deltas + final text, sending stream:true', async () => {
    let captured: { url: string; init: RequestInit } | undefined
    const frames = [
      'event: message_start\ndata: {"type":"message_start"}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]
    const fetchFn = (async (url: string, init: RequestInit) => {
      captured = { url, init }
      return sseResponse(frames)
    }) as unknown as typeof fetch

    const p = new AnthropicProvider({ apiKey: 'sk-ant-x', model: 'claude-haiku-4-5', fetchFn })
    const deltas: string[] = []
    const res = await p.chatStream!({ system: 'S', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 }, d => deltas.push(d))

    expect(captured!.url).toContain('/v1/messages')
    const body = JSON.parse(captured!.init.body as string)
    expect(body.stream).toBe(true)
    expect(body.system).toBe('S')
    expect(deltas).toEqual(['Hel', 'lo'])
    expect(res.text).toBe('Hello')
    expect(res.stopReason).toBe('end_turn')
  })

  it('handles a chunk that splits a frame across two reads', async () => {
    const fetchFn = (async () => sseResponse([
      'event: content_block_delta\ndata: {"type":"content_block_de',
      'lta","delta":{"type":"text_delta","text":"AB"}}\n\n',
    ])) as unknown as typeof fetch
    const p = new AnthropicProvider({ apiKey: 'k', model: 'm', fetchFn })
    const deltas: string[] = []
    const res = await p.chatStream!({ system: 'S', messages: [{ role: 'user', content: 'x' }] }, d => deltas.push(d))
    expect(deltas).toEqual(['AB'])
    expect(res.text).toBe('AB')
  })
})

describe('OpenAiCompatibleProvider.chatStream', () => {
  it('parses choices[].delta.content SSE into assembled deltas, sending stream:true', async () => {
    let captured: { init: RequestInit } | undefined
    const frames = [
      'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}},{"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]
    const fetchFn = (async (_url: string, init: RequestInit) => {
      captured = { init }
      return sseResponse(frames)
    }) as unknown as typeof fetch

    const p = new OpenAiCompatibleProvider({ name: 'openai', apiKey: 'k', model: 'gpt', baseUrl: 'https://api.openai.com/v1', fetchFn })
    const deltas: string[] = []
    const res = await p.chatStream!({ system: 'S', messages: [{ role: 'user', content: 'hi' }] }, d => deltas.push(d))

    const body = JSON.parse(captured!.init.body as string)
    expect(body.stream).toBe(true)
    expect(body.messages[0]).toEqual({ role: 'system', content: 'S' })
    expect(deltas).toEqual(['Hel', 'lo'])
    expect(res.text).toBe('Hello')
    expect(res.stopReason).toBe('stop')
  })
})

describe('MockProvider.chatStream', () => {
  it('chunks its deterministic reply into several deltas whose concat equals chat()', async () => {
    const p = new MockProvider()
    const full = await p.chat({ system: 's', messages: [{ role: 'user', content: 'hello world this is a longish message' }] })
    const deltas: string[] = []
    const streamed = await p.chatStream!({ system: 's', messages: [{ role: 'user', content: 'hello world this is a longish message' }] }, d => deltas.push(d))
    expect(deltas.length).toBeGreaterThan(1) // actually streams in pieces
    expect(deltas.join('')).toBe(full.text)
    expect(streamed.text).toBe(full.text)
  })
  it('streams a scripted reply too', async () => {
    const p = new MockProvider({ reply: 'one two three four five six seven' })
    const deltas: string[] = []
    const res = await p.chatStream!({ system: 's', messages: [] }, d => deltas.push(d))
    expect(deltas.join('')).toBe('one two three four five six seven')
    expect(res.text).toBe('one two three four five six seven')
  })
})
