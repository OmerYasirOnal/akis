import { describe, it, expect } from 'vitest'
import { LlmAdvisoryAgent } from '../../src/agent/dynamic/AdvisoryAgent.js'
import { ToolRegistry } from '../../src/agent/tools/ToolRegistry.js'
import type { LlmProvider, ChatRequest, ChatResult } from '../../src/agent/LlmProvider.js'
import { initialSession, type SharedContext } from '@akis/shared'

function makeCtx(): SharedContext {
  return { session: initialSession('s1', 'a todo app'), events: [], scratchpad: { gates: {}, notes: [], errors: [] }, knowledge: [] }
}

function provider(result: ChatResult, capture?: (r: ChatRequest) => void): LlmProvider {
  return { name: 'fake', model: 'fake', async chat(req) { capture?.(req); return result } }
}

describe('LlmAdvisoryAgent', () => {
  it('produces a trimmed note scoped to its role/phase, with an advisory (no-authority) system prompt', async () => {
    let req: ChatRequest | undefined
    const agent = new LlmAdvisoryAgent({ role: 'researcher', provider: provider({ text: '  Use a debounce on input.  ' }, r => { req = r }) })
    const note = await agent.advise({ sessionId: 's1', phase: 'post_code_review', objective: 'review', ctx: makeCtx(), tools: new ToolRegistry() })
    expect(note).toEqual({ role: 'researcher', phase: 'post_code_review', text: 'Use a debounce on input.' })
    expect(req?.system).toMatch(/advisory/i)
    expect(req?.system).toMatch(/no authority/i)
  })

  it('falls back to (no advice) on empty model output', async () => {
    const agent = new LlmAdvisoryAgent({ role: 'r', provider: provider({ text: '' }) })
    const note = await agent.advise({ sessionId: 's1', phase: 'pre_scribe', objective: 'o', ctx: makeCtx(), tools: new ToolRegistry() })
    expect(note.text).toBe('(no advice)')
  })

  it('can call retrieve_knowledge via the injected tool registry mid-turn', async () => {
    const tools = new ToolRegistry()
    let toolArgs: unknown
    tools.register({ spec: { name: 'retrieve_knowledge', description: 'd', schema: {} }, handler: async a => { toolArgs = a; return 'CHUNK: prior art' } })
    let i = 0
    const prov: LlmProvider = {
      name: 'fake', model: 'fake',
      async chat(): Promise<ChatResult> {
        i++
        return i === 1 ? { toolCalls: [{ name: 'retrieve_knowledge', args: { query: 'q' }, id: 'c1' }] } : { text: 'Grounded advice' }
      },
    }
    const agent = new LlmAdvisoryAgent({ role: 'researcher', provider: prov })
    const note = await agent.advise({ sessionId: 's1', phase: 'pre_scribe', objective: 'o', ctx: makeCtx(), tools })
    expect(toolArgs).toEqual({ query: 'q' })
    expect(note.text).toBe('Grounded advice')
  })
})
