import { describe, it, expect, vi } from 'vitest'
import { SpecSource } from '../../src/knowledge/ingest/SpecSource.js'
import type { RagService } from '../../src/knowledge/RagService.js'

/** A RagService stand-in that records every ingest input + a queue whose metrics we can assert. */
function fakeRag() {
  const ingested: { text: string; source: string; sourceId: string; userId: string; sessionId: string }[] = []
  const rag = { ingest: vi.fn((i: (typeof ingested)[number]) => { ingested.push(i) }) } as unknown as RagService
  const queue = { metrics: { ingested: 0, failed: 0, deadLettered: 0, dedupHits: 0, excluded: 0, queueDepth: 0 } }
  return { rag, ingested, queue }
}
const src = (f: ReturnType<typeof fakeRag>) => new SpecSource({ rag: f.rag, queue: f.queue as never })

const SPEC = {
  title: 'Minimal Todo App',
  body: '# Minimal Todo App\n\n## Scope\n- Add and remove items\n- Mark items done\n\n## Acceptance criteria\n- A new item appears in the list\n',
}

describe('SpecSource — ingest an approved spec as agent-output grounding', () => {
  it('chunks the spec body and ingests each chunk with source:agent-spec / sourceId:sessionId', () => {
    const f = fakeRag()
    src(f).ingest({ sessionId: 's1', userId: 'u1', spec: SPEC })
    const { ingested } = f
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

  it('does NOT duplicate the H1 when the body already opens with the title heading (LOW-1)', () => {
    const f = fakeRag()
    // SPEC.body starts with "# Minimal Todo App" and title is "Minimal Todo App".
    src(f).ingest({ sessionId: 's1', userId: 'u1', spec: SPEC })
    const joined = f.ingested.map(i => i.text).join('\n')
    // The title heading appears, but not doubled (no "# Minimal Todo App\n\n# Minimal Todo App").
    expect(joined).not.toMatch(/#\s*Minimal Todo App[\s\S]*#\s*Minimal Todo App/)
  })

  it('prepends the title as an H1 when the body does NOT already lead with it', () => {
    const f = fakeRag()
    src(f).ingest({ sessionId: 's1', userId: 'u1', spec: { title: 'Widget Factory', body: 'Just some scope text with no heading.' } })
    expect(f.ingested.map(i => i.text).join('\n')).toMatch(/# Widget Factory/)
  })

  it('ingests NOTHING for an empty/whitespace spec body (no empty chunks)', () => {
    const f = fakeRag()
    src(f).ingest({ sessionId: 's1', userId: 'u1', spec: { title: '', body: '   \n  ' } })
    expect(f.ingested).toHaveLength(0)
  })

  it('excludes a secret-bearing spec AND bumps metrics.excluded (observability parity with RepoSource, LOW-2)', () => {
    const f = fakeRag()
    src(f).ingest({ sessionId: 's1', userId: 'u1', spec: { title: 'x', body: 'AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLEwJalrXUtnFEMIK7MDENGbPxRfiCY' } })
    expect(f.ingested).toHaveLength(0)
    expect(f.queue.metrics.excluded).toBe(1) // the drop is now visible on /api/ops RAG health
  })
})
