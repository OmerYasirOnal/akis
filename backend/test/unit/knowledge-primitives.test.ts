import { describe, it, expect } from 'vitest'
import { LocalEmbeddingProvider } from '../../src/knowledge/embedding/EmbeddingProvider.js'
import { MemoryVectorStore } from '../../src/knowledge/store/MemoryVectorStore.js'
import { Bm25Index } from '../../src/knowledge/store/Bm25Index.js'
import { rrfFuse } from '../../src/knowledge/retrieve/hybrid.js'
import { chunkText } from '../../src/knowledge/ingest/chunk.js'
import { shouldExclude } from '../../src/knowledge/ingest/exclude.js'
import { contentHash } from '../../src/knowledge/ingest/hash.js'
import type { StoredChunk, ChunkMeta } from '../../src/knowledge/store/VectorStore.js'

const meta = (over: Partial<ChunkMeta> = {}): ChunkMeta => ({ source: 'conversation', sourceId: 's1', userId: 'u1', sessionId: 's1', createdAt: '2026-06-01T00:00:00Z', ...over })

async function stored(emb: LocalEmbeddingProvider, id: string, text: string, m?: Partial<ChunkMeta>): Promise<StoredChunk> {
  const [vector] = await emb.embed([text])
  return { id, vector: vector!, chunk: { id, text, source: 'conversation', score: 0 }, meta: meta(m) }
}

describe('LocalEmbeddingProvider', () => {
  it('is deterministic, fixed-dim, L2-normalized', async () => {
    const emb = new LocalEmbeddingProvider(256)
    const [a] = await emb.embed(['todo app with sqlite'])
    const [b] = await emb.embed(['todo app with sqlite'])
    expect(a).toEqual(b)
    expect(a!.length).toBe(256)
    const norm = Math.sqrt(a!.reduce((s, x) => s + x * x, 0))
    expect(norm).toBeCloseTo(1, 5)
  })
  it('differs for different text', async () => {
    const emb = new LocalEmbeddingProvider()
    const [a] = await emb.embed(['payments and billing'])
    const [b] = await emb.embed(['todo list app'])
    expect(a).not.toEqual(b)
  })
})

describe('MemoryVectorStore', () => {
  it('ranks by cosine and dedups by id (idempotent upsert)', async () => {
    const emb = new LocalEmbeddingProvider()
    const store = new MemoryVectorStore()
    store.upsert(await stored(emb, 'a', 'database migrations with postgres'))
    store.upsert(await stored(emb, 'b', 'frontend react components and css'))
    store.upsert(await stored(emb, 'a', 'database migrations with postgres'))
    expect(store.size()).toBe(2)
    const [q] = await emb.embed(['postgres database schema'])
    const res = store.search(q!, { userId: 'u1' }, 2)
    expect(res[0]?.stored.id).toBe('a')
  })
  it('enforces tenancy (user B never sees user A) and deleteBy', async () => {
    const emb = new LocalEmbeddingProvider()
    const store = new MemoryVectorStore()
    store.upsert(await stored(emb, 'a', 'secret roadmap', { userId: 'A' }))
    const [q] = await emb.embed(['roadmap'])
    expect(store.search(q!, { userId: 'B' }, 5)).toHaveLength(0)
    expect(store.search(q!, { userId: 'A' }, 5)).toHaveLength(1)
    expect(store.deleteBy(m => m.userId === 'A')).toBe(1)
    expect(store.size()).toBe(0)
  })
})

describe('Bm25Index', () => {
  it('ranks by lexical relevance, tenancy-filtered', async () => {
    const emb = new LocalEmbeddingProvider()
    const idx = new Bm25Index()
    idx.add(await stored(emb, 'a', 'the quick brown fox jumps'))
    idx.add(await stored(emb, 'b', 'lazy dogs sleep all day'))
    const res = idx.search('quick fox', { userId: 'u1' }, 2)
    expect(res[0]?.stored.id).toBe('a')
    expect(idx.search('quick fox', { userId: 'other' }, 2)).toHaveLength(0)
  })
})

describe('rrfFuse', () => {
  it('fuses two ranked lists so a doc strong in either modality surfaces', () => {
    const mk = (id: string): { stored: StoredChunk; score: number } => ({ stored: { id, vector: [], chunk: { id, text: id, source: 'x', score: 0 }, meta: meta() }, score: 1 })
    const vec = [mk('a'), mk('b'), mk('c')]
    const lex = [mk('c'), mk('d')]
    const fused = rrfFuse([vec, lex], 4)
    expect(fused[0]?.stored.id).toBe('c')
    expect(fused.map(f => f.stored.id).sort()).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('chunk / exclude / hash', () => {
  it('chunks long text into overlapping windows; short text -> one chunk', () => {
    expect(chunkText('short')).toEqual(['short'])
    const long = 'x'.repeat(2000)
    expect(chunkText(long, { size: 800, overlap: 100 }).length).toBeGreaterThan(1)
  })
  it('excludes secret sources, secret content, and binary; allows normal text', () => {
    const binary = String.fromCharCode(0, 0, 0, 0, 0) + 'a' // mostly null bytes
    expect(shouldExclude('whatever', '.env').excluded).toBe(true)
    expect(shouldExclude('whatever', 'backend/.akis/keys.json').excluded).toBe(true)
    expect(shouldExclude('my key is sk-ant-abcdefghijklmnop1234', 'notes.md').excluded).toBe(true)
    expect(shouldExclude(binary, 'blob.bin').excluded).toBe(true)
    expect(shouldExclude('a normal sentence about todos', 'notes.md').excluded).toBe(false)
  })
  it('catches every secret pattern, including keys followed by a word char (M1 regression)', () => {
    const cases = [
      'here is sk-proj-abcdefghijklmnop1234567890 in code',   // modern OpenAI (hyphen in body)
      'GH_TOKEN=ghp_abcdefghijklmnopqrstuvwx_v2',              // GitHub token followed by _
      'gho_abcdefghijklmnopqrstuvwxyz0123',                    // GitHub oauth
      'aws AKIAIOSFODNN7EXAMPLE rotated',                      // AWS access key id
      'google AIzaSyA1234567890abcdefghijklmnopqrstu key',     // Google API key
      'slack xoxb-1234567890-abcdefghijklmno token',           // Slack
      'anthropic sk-ant-api03-abcdefghijklmnopqrst usage',     // Anthropic
    ]
    for (const c of cases) expect(shouldExclude(c, 'notes.md').excluded, c).toBe(true)
  })
  it('contentHash is stable for identical content+scope and differs otherwise', () => {
    const scope = { userId: 'u1', source: 'conversation', sourceId: 's1' }
    expect(contentHash('hello', scope)).toBe(contentHash('hello', scope))
    expect(contentHash('hello', scope)).not.toBe(contentHash('world', scope))
    expect(contentHash('hello', scope)).not.toBe(contentHash('hello', { ...scope, userId: 'u2' }))
  })
})
