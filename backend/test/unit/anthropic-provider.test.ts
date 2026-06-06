import { describe, it, expect } from 'vitest'
import { AnthropicProvider } from '../../src/agent/providers/AnthropicProvider.js'

const okBody = {
  content: [
    { type: 'text', text: 'hi' },
    { type: 'tool_use', id: 'toolu_1', name: 'do', input: { x: 1 } },
  ],
  stop_reason: 'tool_use',
  usage: { input_tokens: 5, output_tokens: 7 },
}

describe('AnthropicProvider', () => {
  it('maps request headers + body and parses text + tool_use', async () => {
    let captured: { url: string; init: RequestInit } | undefined
    const fetchFn = (async (url: string, init: RequestInit) => {
      captured = { url, init }
      return new Response(JSON.stringify(okBody), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch

    const p = new AnthropicProvider({ apiKey: 'sk-ant-x', model: 'claude-haiku-4-5-20251001', fetchFn })
    const r = await p.chat({
      system: 'SYS',
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'do', description: 'd', schema: { type: 'object' } }],
      maxTokens: 100,
    })

    const h = captured!.init.headers as Record<string, string>
    expect(captured!.url).toContain('/v1/messages')
    expect(h['x-api-key']).toBe('sk-ant-x')
    expect(h['anthropic-version']).toBe('2023-06-01')
    const body = JSON.parse(captured!.init.body as string)
    // System rides as a content block with a PROMPT-CACHE breakpoint (cache_control), so the
    // shared agent prefix is cached across calls. Same text, byte-identical responses.
    expect(body.system).toEqual([{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }])
    expect(body.max_tokens).toBe(100)
    expect(body.tools[0].input_schema).toEqual({ type: 'object' })

    expect(r.text).toBe('hi')
    expect(r.toolCalls).toEqual([{ id: 'toolu_1', name: 'do', args: { x: 1 } }])
    expect(r.usage).toEqual({ inTokens: 5, outTokens: 7 })
    expect(r.stopReason).toBe('tool_use')
  })

  it('falls back to the configured model when the request model is an EMPTY string (not just undefined)', async () => {
    // The "(default)" model picker passes model:"" per agent. `??` would forward "" to the
    // API → Anthropic 400 "model: String should have at least 1 character". Must use `||`.
    let captured: { init: RequestInit } | undefined
    const fetchFn = (async (_url: string, init: RequestInit) => {
      captured = { init }
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const p = new AnthropicProvider({ apiKey: 'sk-ant-x', model: 'claude-haiku-4-5-20251001', fetchFn })
    await p.chat({ system: 'S', model: '', messages: [{ role: 'user', content: 'go' }] })
    const body = JSON.parse(captured!.init.body as string)
    expect(body.model).toBe('claude-haiku-4-5-20251001')
  })

  it('maps a tool result message to a user tool_result block', async () => {
    let captured: { init: RequestInit } | undefined
    const fetchFn = (async (_url: string, init: RequestInit) => {
      captured = { init }
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const p = new AnthropicProvider({ apiKey: 'sk-ant-x', model: 'm', fetchFn })
    await p.chat({
      system: 'S',
      messages: [
        { role: 'assistant', content: '', toolCalls: [{ id: 'toolu_1', name: 'do', args: {} }] },
        { role: 'tool', content: 'result-text', toolCallId: 'toolu_1' },
      ],
    })
    const body = JSON.parse(captured!.init.body as string)
    const toolMsg = body.messages[1]
    expect(toolMsg.role).toBe('user')
    expect(toolMsg.content[0]).toEqual({ type: 'tool_result', tool_use_id: 'toolu_1', content: 'result-text' })
  })
})

describe('cache-token visibility (audit quick-win — prompt caching observable, never re-weighted)', () => {
  it('maps cache_read/cache_creation into OPTIONAL usage fields; inTokens stays the uncached remainder', async () => {
    const body = {
      content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 4096, cache_creation_input_tokens: 1024 },
    }
    const fetchFn = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch
    const p = new AnthropicProvider({ apiKey: 'sk-ant-x', model: 'claude-haiku-4-5-20251001', fetchFn })
    const r = await p.chat({ system: 'SYS', messages: [{ role: 'user', content: 'q' }] })
    expect(r.usage).toEqual({ inTokens: 12, outTokens: 3, cacheReadTokens: 4096, cacheCreateTokens: 1024 })
  })

  it('absent cache fields keep usage byte-identical (no spurious keys)', async () => {
    const body = { content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 5, output_tokens: 7 } }
    const fetchFn = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch
    const p = new AnthropicProvider({ apiKey: 'sk-ant-x', model: 'claude-haiku-4-5-20251001', fetchFn })
    const r = await p.chat({ system: 'SYS', messages: [{ role: 'user', content: 'q' }] })
    expect(r.usage).toEqual({ inTokens: 5, outTokens: 7 })
  })
})

describe('multi-turn prompt caching (audit fix: the system-only marker was INERT below the 4096-token minimum)', () => {
  function capture() {
    const seen: { body?: Record<string, unknown> } = {}
    const fetchFn = (async (_url: string, init: RequestInit) => {
      seen.body = JSON.parse(String(init.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 })
    }) as unknown as typeof fetch
    return { seen, fetchFn }
  }

  it('a LARGE conversation gets a cache breakpoint on the LAST message (the iterate-round prefix)', async () => {
    const { seen, fetchFn } = capture()
    const p = new AnthropicProvider({ apiKey: 'sk-ant-x', model: 'claude-haiku-4-5-20251001', fetchFn })
    const big = 'x'.repeat(20_000) // ~5k tokens — clears CACHE_MIN_PROMPT_TOKENS
    await p.chat({ system: 'SYS', messages: [{ role: 'user', content: big }, { role: 'assistant', content: 'draft' }, { role: 'user', content: 'iterate: fix the header' }] })
    const msgs = seen.body!.messages as { content: unknown }[]
    const last = msgs[msgs.length - 1]!.content as { type: string; text: string; cache_control?: unknown }[]
    expect(Array.isArray(last)).toBe(true)
    expect(last[last.length - 1]!.cache_control).toEqual({ type: 'ephemeral' })
    // earlier messages stay plain string content (only the breakpoint message converts)
    expect(typeof msgs[0]!.content).toBe('string')
  })

  it('a SMALL chat stays byte-identical (sub-minimum marker would be inert — none added)', async () => {
    const { seen, fetchFn } = capture()
    const p = new AnthropicProvider({ apiKey: 'sk-ant-x', model: 'claude-haiku-4-5-20251001', fetchFn })
    await p.chat({ system: 'SYS', messages: [{ role: 'user', content: 'merhaba' }] })
    const msgs = seen.body!.messages as { content: unknown }[]
    expect(typeof msgs[0]!.content).toBe('string') // untouched
  })
})
