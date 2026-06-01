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
    expect(body.system).toBe('SYS')
    expect(body.max_tokens).toBe(100)
    expect(body.tools[0].input_schema).toEqual({ type: 'object' })

    expect(r.text).toBe('hi')
    expect(r.toolCalls).toEqual([{ id: 'toolu_1', name: 'do', args: { x: 1 } }])
    expect(r.usage).toEqual({ inTokens: 5, outTokens: 7 })
    expect(r.stopReason).toBe('tool_use')
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
