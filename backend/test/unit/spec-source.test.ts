import { describe, it, expect, vi } from 'vitest'
import { SpecSource } from '../../src/knowledge/ingest/SpecSource.js'
import type { RagService } from '../../src/knowledge/RagService.js'

/** A RagService stand-in that records every ingest input. */
function fakeRag() {
  const ingested: { text: string; source: string; sourceId: string; userId: string; sessionId: string }[] = []
  const rag = { ingest: vi.fn((i: (typeof ingested)[number]) => { ingested.push(i) }) } as unknown as RagService
  return { rag, ingested }
}

const SPEC = {
  title: 'Minimal Todo App',
  body: '# Minimal Todo App\n\n## Scope\n- Add and remove items\n- Mark items done\n\n## Acceptance criteria\n- A new item appears in the list\n',
}

describe('SpecSource — ingest an approved spec as agent-output grounding', () => {
  it('chunks the spec body and ingests each chunk with source:agent-spec / sourceId:sessionId', () => {
    const { rag, ingested } = fakeRag()
    new SpecSource({ rag }).ingest({ sessionId: 's1', userId: 'u1', spec: SPEC })
    expect(ingested.length).toBeGreaterThan(0)
    for (const i of ingested) {
      expect(i.source).toBe('agent-spec')
      expect(i.sourceId).toBe('s1')
      expect(i.userId).toBe('u1')
      expect(i.sessionId).toBe('s1')
    }
    // The spec content actually reaches the corpus (some chunk carries the scope text).
    expect(ingested.map(i => i.text).join('\n')).toMatch(/Add and remove items/)
    // The title is carried as grounding context (first chunk or a heading).
    expect(ingested.map(i => i.text).join('\n')).toMatch(/Minimal Todo App/)
  })

  it('ingests NOTHING for an empty/whitespace spec body (no empty chunks)', () => {
    const { rag, ingested } = fakeRag()
    new SpecSource({ rag }).ingest({ sessionId: 's1', userId: 'u1', spec: { title: '', body: '   \n  ' } })
    expect(ingested).toHaveLength(0)
  })

  it('excludes a spec body that trips the secret filter (belt-and-suspenders, never embeds a secret)', () => {
    const { rag, ingested } = fakeRag()
    // A body carrying an obvious secret assignment must not become grounding.
    new SpecSource({ rag }).ingest({ sessionId: 's1', userId: 'u1', spec: { title: 'x', body: 'AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLEwJalrXUtnFEMIK7MDENGbPxRfiCY' } })
    expect(ingested).toHaveLength(0)
  })
})
