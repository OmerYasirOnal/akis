import { describe, it, expect } from 'vitest'
import { callWithTools } from '../../src/agent/tools/toolLoop.js'
import { ToolRegistry } from '../../src/agent/tools/ToolRegistry.js'
import type { LlmProvider, ChatRequest, ChatResult } from '../../src/agent/LlmProvider.js'

/** A provider scripted with a queue of results; captures each request it receives. */
function scriptedProvider(results: ChatResult[]): LlmProvider & { calls: ChatRequest[] } {
  const calls: ChatRequest[] = []
  let i = 0
  return {
    name: 'fake',
    model: 'fake',
    calls,
    async chat(req: ChatRequest): Promise<ChatResult> {
      calls.push(req)
      return results[i++] ?? { text: 'done' }
    },
  }
}

describe('callWithTools', () => {
  it('dispatches a tool call, feeds the result back, and returns the final text', async () => {
    const reg = new ToolRegistry()
    let seen: unknown
    reg.register({
      spec: { name: 'retrieve_knowledge', description: 'd', schema: { type: 'object' } },
      handler: async a => { seen = a; return 'CHUNK: the answer is 42' },
    })
    const provider = scriptedProvider([
      { toolCalls: [{ name: 'retrieve_knowledge', args: { query: 'q' }, id: 'c1' }] },
      { text: 'Final: 42' },
    ])

    const res = await callWithTools(provider, { system: 's', messages: [{ role: 'user', content: 'go' }] }, reg)

    expect(seen).toEqual({ query: 'q' })
    expect(res.text).toBe('Final: 42')
    // Registry specs are advertised to the provider.
    expect(provider.calls[0]!.tools?.[0]?.name).toBe('retrieve_knowledge')
    // The second turn carries the assistant tool-call turn + the correlated tool result.
    const second = provider.calls[1]!
    const toolMsg = second.messages.find(m => m.role === 'tool')
    expect(toolMsg?.content).toContain('the answer is 42')
    expect(toolMsg?.toolName).toBe('retrieve_knowledge')
    expect(toolMsg?.toolCallId).toBe('c1')
    expect(second.messages.some(m => m.role === 'assistant' && m.toolCalls?.length)).toBe(true)
  })

  it('returns immediately when the model makes no tool call', async () => {
    const reg = new ToolRegistry()
    const provider = scriptedProvider([{ text: 'no tools needed' }])
    const res = await callWithTools(provider, { system: 's', messages: [] }, reg)
    expect(res.text).toBe('no tools needed')
    expect(provider.calls).toHaveLength(1)
  })

  it('feeds a handler error back as a tool result instead of throwing', async () => {
    const reg = new ToolRegistry()
    reg.register({ spec: { name: 'boom', description: 'd', schema: {} }, handler: async () => { throw new Error('kaboom') } })
    const provider = scriptedProvider([
      { toolCalls: [{ name: 'boom', args: {}, id: 'c1' }] },
      { text: 'recovered' },
    ])
    const res = await callWithTools(provider, { system: 's', messages: [] }, reg)
    expect(res.text).toBe('recovered')
    const toolMsg = provider.calls[1]!.messages.find(m => m.role === 'tool')
    expect(toolMsg?.content).toMatch(/error/i)
  })

  it('stops at maxTurns even if the model keeps calling tools', async () => {
    const reg = new ToolRegistry()
    reg.register({ spec: { name: 'loop', description: 'd', schema: {} }, handler: async () => 'again' })
    const provider = scriptedProvider([
      { toolCalls: [{ name: 'loop', args: {}, id: 'a' }] },
      { toolCalls: [{ name: 'loop', args: {}, id: 'b' }] },
      { toolCalls: [{ name: 'loop', args: {}, id: 'c' }] },
    ])
    const res = await callWithTools(provider, { system: 's', messages: [] }, reg, { maxTurns: 2 })
    expect(provider.calls).toHaveLength(2) // budget spent after 2 round-trips
    expect(res.toolCalls?.length).toBe(1) // last turn still wanted a tool — handed back as-is
  })
})
