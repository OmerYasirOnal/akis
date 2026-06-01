import { describe, it, expect } from 'vitest'
import { AnthropicProvider } from '../../src/agent/providers/AnthropicProvider.js'
import { OpenAiCompatibleProvider } from '../../src/agent/providers/OpenAiCompatibleProvider.js'
import { GeminiProvider } from '../../src/agent/providers/GeminiProvider.js'
import type { ChatMessage } from '../../src/agent/LlmProvider.js'

/**
 * Multi-turn tool reconstruction (outbound mapMessage). These paths are not yet
 * reached in production (the critic does single-turn calls), but they are the
 * exact bugs that would surface the instant a tool loop is wired — so they are
 * pinned now per review #2.
 */
const ok = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch

const turns: ChatMessage[] = [
  { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'lookup', args: { q: 'x' } }] },
  { role: 'tool', content: 'the-result', toolCallId: 't1', toolName: 'lookup' },
]

describe('Anthropic multi-turn tool reconstruction', () => {
  it('emits an assistant tool_use turn + a user tool_result block (first, correlated by id)', async () => {
    let captured: RequestInit | undefined
    const fetchFn = (async (_u: string, init: RequestInit) => { captured = init; return new Response('{"content":[]}', { status: 200, headers: { 'content-type': 'application/json' } }) }) as unknown as typeof fetch
    await new AnthropicProvider({ apiKey: 'sk-ant-x', model: 'm', fetchFn }).chat({ system: 'S', messages: turns })
    const b = JSON.parse(captured!.body as string)
    expect(b.messages[0].content.find((c: { type: string }) => c.type === 'tool_use').id).toBe('t1')
    expect(b.messages[1].content[0]).toEqual({ type: 'tool_result', tool_use_id: 't1', content: 'the-result' })
  })
})

describe('OpenAI multi-turn tool reconstruction', () => {
  it('arguments is a STRING and tool_call_id correlates', async () => {
    let captured: RequestInit | undefined
    const fetchFn = (async (_u: string, init: RequestInit) => { captured = init; return new Response('{"choices":[{"message":{}}]}', { status: 200, headers: { 'content-type': 'application/json' } }) }) as unknown as typeof fetch
    await new OpenAiCompatibleProvider({ name: 'openai', apiKey: 'sk-x', model: 'm', baseUrl: 'https://api.openai.com/v1', fetchFn }).chat({ system: 'S', messages: turns })
    const b = JSON.parse(captured!.body as string)
    const asst = b.messages.find((m: { role: string }) => m.role === 'assistant')
    expect(typeof asst.tool_calls[0].function.arguments).toBe('string')
    expect(JSON.parse(asst.tool_calls[0].function.arguments)).toEqual({ q: 'x' })
    const tool = b.messages.find((m: { role: string }) => m.role === 'tool')
    expect(tool.tool_call_id).toBe('t1')
  })
})

describe('Gemini multi-turn tool reconstruction', () => {
  it('functionResponse name matches the functionCall name (correlated by name)', async () => {
    let captured: RequestInit | undefined
    const fetchFn = (async (_u: string, init: RequestInit) => { captured = init; return new Response('{"candidates":[]}', { status: 200, headers: { 'content-type': 'application/json' } }) }) as unknown as typeof fetch
    await new GeminiProvider({ apiKey: 'AIza', model: 'm', fetchFn }).chat({ system: 'S', messages: turns })
    const b = JSON.parse(captured!.body as string)
    const model = b.contents.find((c: { role: string }) => c.role === 'model')
    expect(model.parts.find((p: { functionCall?: unknown }) => p.functionCall).functionCall.name).toBe('lookup')
    const resp = b.contents.find((c: { parts: { functionResponse?: unknown }[] }) => c.parts.some(p => p.functionResponse))
    expect(resp.parts[0].functionResponse.name).toBe('lookup') // toolName carried, not 'tool'
  })
})
