import { describe, it, expect } from 'vitest'
import { LocalReranker, NoopReranker } from '../../src/knowledge/retrieve/Reranker.js'
import type { Scored, StoredChunk, ChunkMeta } from '../../src/knowledge/store/VectorStore.js'

const meta = (): ChunkMeta => ({ source: 'corpus', sourceId: 's1', userId: 'u1', sessionId: 's1', createdAt: '2026-06-01T00:00:00Z' })

const cand = (id: string, text: string, score: number): Scored => ({
  stored: { id, vector: [], chunk: { id, text, source: `corpus:${id}`, score: 0 }, meta: meta() },
  score,
})

describe('LocalReranker', () => {
  it('is deterministic and offline: same input -> same order', () => {
    const r = new LocalReranker()
    const cands = [
      cand('a', 'postgres database migrations and schema design', 0.02),
      cand('b', 'redis caching layer ttl eviction buckets', 0.02),
      cand('c', 'stripe payments billing invoices subscriptions', 0.02),
    ]
    const out1 = r.rerank('postgres database schema', cands, 3)
    const out2 = r.rerank('postgres database schema', cands, 3)
    expect(out1.map(s => s.stored.id)).toEqual(out2.map(s => s.stored.id))
  })

  it('promotes the lexically/semantically best above a weak rrf-tie', () => {
    const r = new LocalReranker()
    // All three carry the SAME (tied) rrf score; the one matching the query lexically
    // must be promoted to the top by the reranker.
    const cands = [
      cand('unrelated1', 'redis caching layer ttl eviction buckets rate limiting', 0.0164),
      cand('target', 'postgres database migrations schema indexes query optimization', 0.0164),
      cand('unrelated2', 'stripe payments billing invoices subscriptions checkout', 0.0164),
    ]
    const out = r.rerank('postgres database schema migrations', cands, 3)
    expect(out[0]?.stored.id).toBe('target')
  })

  it('respects k (returns at most k)', () => {
    const r = new LocalReranker()
    const cands = [
      cand('a', 'alpha text here', 0.03),
      cand('b', 'beta text here', 0.02),
      cand('c', 'gamma text here', 0.01),
      cand('d', 'delta text here', 0.005),
    ]
    expect(r.rerank('alpha', cands, 2)).toHaveLength(2)
    expect(r.rerank('alpha', cands, 10).length).toBeLessThanOrEqual(cands.length)
  })

  it('empty candidates -> []', () => {
    const r = new LocalReranker()
    expect(r.rerank('anything', [], 5)).toEqual([])
  })

  it('produces a stable sort on a query with no lexical overlap (preserves prior order)', () => {
    const r = new LocalReranker()
    const cands = [
      cand('a', 'redis caching layer', 0.02),
      cand('b', 'stripe payments billing', 0.02),
      cand('c', 'websocket realtime presence', 0.02),
    ]
    const out = r.rerank('zzz nomatch token', cands, 3)
    expect(out.map(s => s.stored.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('NoopReranker', () => {
  it('is identity (returns candidates unchanged, sliced to k)', () => {
    const r = new NoopReranker()
    const cands = [
      cand('a', 'first', 0.03),
      cand('b', 'second', 0.02),
      cand('c', 'third', 0.01),
    ]
    expect(r.rerank('whatever', cands, 5).map(s => s.stored.id)).toEqual(['a', 'b', 'c'])
    expect(r.rerank('whatever', cands, 2).map(s => s.stored.id)).toEqual(['a', 'b'])
  })

  it('empty candidates -> []', () => {
    const r = new NoopReranker()
    expect(r.rerank('q', [], 3)).toEqual([])
  })
})
