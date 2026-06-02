import { describe, it, expect } from 'vitest'
import { retrieveKnowledgeTool } from '../../src/agent/tools/retrieveKnowledgeTool.js'
import type { KnowledgePort, RetrieveQuery } from '../../src/knowledge/KnowledgePort.js'
import type { KnowledgeChunk } from '@akis/shared'

function port(chunks: KnowledgeChunk[], onQuery?: (q: RetrieveQuery) => void): KnowledgePort {
  return { async retrieve(q) { onQuery?.(q); return chunks } }
}

describe('retrieveKnowledgeTool', () => {
  it('advertises a retrieve_knowledge spec requiring a query', () => {
    const t = retrieveKnowledgeTool({ knowledge: port([]), sessionId: 's1' })
    expect(t.spec.name).toBe('retrieve_knowledge')
    expect((t.spec.schema as { required?: string[] }).required).toContain('query')
  })

  it('formats chunks (source + score + text) and threads sessionId/limit to the port', async () => {
    let seen: RetrieveQuery | undefined
    const chunks: KnowledgeChunk[] = [{ id: '1', text: 'AKIS verifies with real tests', source: 'docs/x.md', score: 0.91 }]
    const t = retrieveKnowledgeTool({ knowledge: port(chunks, q => { seen = q }), sessionId: 's1', limit: 3 })
    const out = await t.handler({ query: 'how does verification work' })
    expect(seen).toEqual({ query: 'how does verification work', sessionId: 's1', limit: 3 })
    expect(out).toContain('docs/x.md')
    expect(out).toContain('AKIS verifies with real tests')
  })

  it('returns a friendly message when nothing is found', async () => {
    const t = retrieveKnowledgeTool({ knowledge: port([]), sessionId: 's1' })
    expect(await t.handler({ query: 'q' })).toMatch(/no relevant/i)
  })

  it('rejects a non-string query WITHOUT calling the port', async () => {
    let called = false
    const t = retrieveKnowledgeTool({ knowledge: { async retrieve() { called = true; return [] } }, sessionId: 's1' })
    const out = await t.handler({ notquery: 1 })
    expect(out).toMatch(/query/i)
    expect(called).toBe(false)
  })

  it('degrades gracefully if retrieval throws', async () => {
    const t = retrieveKnowledgeTool({ knowledge: { async retrieve() { throw new Error('db down') } }, sessionId: 's1' })
    expect(await t.handler({ query: 'q' })).toMatch(/error/i)
  })
})
