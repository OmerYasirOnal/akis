import { describe, it, expect } from 'vitest'
import { MockProvider } from '../../src/agent/mock/MockProvider.js'

describe('MockProvider', () => {
  it('returns scripted tool calls in order', async () => {
    const p = new MockProvider({ script: [
      { toolCalls: [{ name: 'dispatch_scribe', args: { idea: 'x' } }] },
      { text: 'done' },
    ] })
    const a = await p.chat({ role: 'orchestrator', system: '', messages: [], tools: [] })
    expect(a.toolCalls?.[0].name).toBe('dispatch_scribe')
    const b = await p.chat({ role: 'orchestrator', system: '', messages: [], tools: [] })
    expect(b.text).toBe('done')
  })
  it('exposes knobs for deterministic scenarios', () => {
    const p = new MockProvider({ script: [], knobs: { mockTraceTestCount: 0 } })
    expect(p.knobs.mockTraceTestCount).toBe(0)
  })
})
