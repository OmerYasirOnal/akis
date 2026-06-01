import { describe, it, expect } from 'vitest'
import { renderKnowledge } from '../../src/orchestrator/subagents/context-prompt.js'
import type { SharedContext, KnowledgeChunk } from '@akis/shared'

const ctx = (knowledge: KnowledgeChunk[]): SharedContext => ({
  session: { id: 's1', status: 'composing', idea: 'i', version: 0 },
  events: [],
  scratchpad: { gates: {}, notes: [], errors: [] },
  knowledge,
})
const chunk = (n: number): KnowledgeChunk => ({ id: `k${n}`, text: `t${n}`, source: `s${n}`, score: 0.5 })

describe('renderKnowledge', () => {
  it('returns empty string for undefined ctx', () => {
    expect(renderKnowledge(undefined)).toBe('')
  })
  it('returns empty string when there is no knowledge', () => {
    expect(renderKnowledge(ctx([]))).toBe('')
  })
  it('includes all chunks (with source) when under the limit', () => {
    const out = renderKnowledge(ctx([chunk(1), chunk(2)]))
    expect(out).toContain('(s1) t1')
    expect(out).toContain('(s2) t2')
  })
  it('caps to the limit (default 6)', () => {
    const out = renderKnowledge(ctx(Array.from({ length: 10 }, (_, i) => chunk(i))))
    const lines = out.split('\n').filter(l => l.startsWith('- '))
    expect(lines).toHaveLength(6)
  })
  it('honors an explicit limit', () => {
    const out = renderKnowledge(ctx([chunk(1), chunk(2), chunk(3)]), 2)
    const lines = out.split('\n').filter(l => l.startsWith('- '))
    expect(lines).toHaveLength(2)
  })
})
