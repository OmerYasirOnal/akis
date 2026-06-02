import { describe, it, expect } from 'vitest'
import { OpenAiCompatibleProvider } from '../../src/agent/providers/OpenAiCompatibleProvider.js'

const body = {
  choices: [{ message: { content: 'hi', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'do', arguments: '{"x":1}' } }] } }],
  usage: { prompt_tokens: 3, completion_tokens: 4 },
}

describe('OpenAiCompatibleProvider', () => {
  it('maps request (bearer + system message + function tools) and parses tool_calls', async () => {
    let captured: { url: string; init: RequestInit } | undefined
    const fetchFn = (async (url: string, init: RequestInit) => {
      captured = { url, init }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch

    const p = new OpenAiCompatibleProvider({ name: 'openai', apiKey: 'sk-proj-x', model: 'gpt-4.1-mini', baseUrl: 'https://api.openai.com/v1', fetchFn })
    const r = await p.chat({ system: 'SYS', messages: [{ role: 'user', content: 'go' }], tools: [{ name: 'do', description: 'd', schema: { type: 'object' } }] })

    const h = captured!.init.headers as Record<string, string>
    expect(captured!.url).toContain('/chat/completions')
    expect(h.authorization).toBe('Bearer sk-proj-x')
    const reqBody = JSON.parse(captured!.init.body as string)
    expect(reqBody.messages[0]).toEqual({ role: 'system', content: 'SYS' })
    expect(reqBody.tools[0].function.parameters).toEqual({ type: 'object' })

    expect(r.text).toBe('hi')
    expect(r.toolCalls).toEqual([{ id: 'call_1', name: 'do', args: { x: 1 } }])
    expect(r.usage).toEqual({ inTokens: 3, outTokens: 4 })
  })

  it('maps choices[0].finish_reason → stopReason', async () => {
    const resBody = { choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
    const fetchFn = (async () => new Response(JSON.stringify(resBody), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    const p = new OpenAiCompatibleProvider({ name: 'openai', apiKey: 'sk', model: 'm', baseUrl: 'https://api.openai.com/v1', fetchFn })
    const r = await p.chat({ system: 's', messages: [] })
    expect(r.stopReason).toBe('stop')
  })

  it('falls back to {} when tool arguments is invalid JSON', async () => {
    const bad = { choices: [{ message: { tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'do', arguments: 'not json' } }] } }] }
    const fetchFn = (async () => new Response(JSON.stringify(bad), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    const p = new OpenAiCompatibleProvider({ name: 'openrouter', apiKey: 'sk-or-x', model: 'm', baseUrl: 'https://openrouter.ai/api/v1', fetchFn })
    const r = await p.chat({ system: 's', messages: [] })
    expect(r.toolCalls).toEqual([{ id: 'call_2', name: 'do', args: {} }])
  })
})
