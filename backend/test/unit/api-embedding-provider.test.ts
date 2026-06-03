import { describe, it, expect } from 'vitest'
import { ApiEmbeddingProvider, selectEmbeddingProvider } from '../../src/knowledge/embedding/ApiEmbeddingProvider.js'
import { LocalEmbeddingProvider } from '../../src/knowledge/embedding/EmbeddingProvider.js'
import { ProviderHttpError } from '../../src/agent/providers/http.js'

/** A canned 200 response carrying OpenAI-shaped embeddings (data[].embedding). */
function okFetch(vectors: number[][], capture?: (url: string, init: RequestInit) => void): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    capture?.(url, init)
    const body = { data: vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })), model: 'text-embedding-3-small' }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
}

describe('ApiEmbeddingProvider (P2-RAG-1: real semantic embeddings behind the port)', () => {
  it('POSTs to the embeddings endpoint with a Bearer key and the texts as a batched `input`', async () => {
    let captured: { url: string; init: RequestInit } | undefined
    const fetchFn = okFetch([[3, 4], [0, 1]], (url, init) => { captured = { url, init } })
    const p = new ApiEmbeddingProvider({ apiKey: 'sk-emb-secret', model: 'text-embedding-3-small', fetchFn })

    await p.embed(['hello world', 'second doc'])

    expect(captured!.url).toBe('https://api.openai.com/v1/embeddings')
    const headers = captured!.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer sk-emb-secret')
    const reqBody = JSON.parse(captured!.init.body as string) as { model: string; input: string[] }
    expect(reqBody.model).toBe('text-embedding-3-small')
    expect(reqBody.input).toEqual(['hello world', 'second doc']) // ONE batched request, not two
  })

  it('parses data[].embedding into vectors and L2-normalizes them (cosine == dot)', async () => {
    const p = new ApiEmbeddingProvider({ apiKey: 'sk-x', fetchFn: okFetch([[3, 4]]) })
    const [v] = await p.embed(['x'])
    // (3,4) has L2 norm 5 → normalized (0.6, 0.8); ||v|| === 1.
    expect(v![0]).toBeCloseTo(0.6, 10)
    expect(v![1]).toBeCloseTo(0.8, 10)
    const norm = Math.sqrt(v!.reduce((s, n) => s + n * n, 0))
    expect(norm).toBeCloseTo(1, 10)
  })

  it('reorders by data[].index so vectors line up with inputs even if the API returns them out of order', async () => {
    const fetchFn = (async () => {
      const body = { data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const p = new ApiEmbeddingProvider({ apiKey: 'sk-x', fetchFn })
    const [first, second] = await p.embed(['a', 'b'])
    expect(first).toEqual([1, 0]) // index 0
    expect(second).toEqual([0, 1]) // index 1
  })

  it('reports the catalog dim for the active model (text-embedding-3-small → 1536)', () => {
    expect(new ApiEmbeddingProvider({ apiKey: 'sk-x', model: 'text-embedding-3-small' }).dim).toBe(1536)
  })

  it('empty input short-circuits — no network call, returns []', async () => {
    let called = false
    const fetchFn = (async () => { called = true; return new Response('{}', { status: 200 }) }) as unknown as typeof fetch
    const p = new ApiEmbeddingProvider({ apiKey: 'sk-x', fetchFn })
    expect(await p.embed([])).toEqual([])
    expect(called).toBe(false)
  })

  it('surfaces a provider error body WITHOUT leaking the key (error message carries no secret)', async () => {
    const errFetch = (async () => new Response(
      JSON.stringify({ error: { message: 'invalid input: too many tokens' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch
    const p = new ApiEmbeddingProvider({ apiKey: 'sk-super-secret-key', fetchFn: errFetch })

    await expect(p.embed(['x'])).rejects.toMatchObject({ status: 400 })
    try {
      await p.embed(['x'])
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderHttpError)
      const msg = (e as Error).message
      expect(msg).toContain('invalid input: too many tokens')
      expect(msg).not.toContain('sk-super-secret-key') // NEVER leak the key
    }
  })
})

describe('selectEmbeddingProvider (selection rule: API only when its key resolves & not test)', () => {
  it('returns the offline LocalEmbeddingProvider under NODE_ENV=test even with a key present', () => {
    const p = selectEmbeddingProvider({ env: { NODE_ENV: 'test', OPENAI_API_KEY: 'sk-x' } })
    expect(p).toBeInstanceOf(LocalEmbeddingProvider)
    expect(p.dim).toBe(256)
  })

  it('returns LocalEmbeddingProvider on a keyless boot (no provider key)', () => {
    const p = selectEmbeddingProvider({ env: { NODE_ENV: 'production' } })
    expect(p).toBeInstanceOf(LocalEmbeddingProvider)
  })

  it('returns ApiEmbeddingProvider when an OpenAI env key resolves (non-test)', () => {
    const p = selectEmbeddingProvider({ env: { NODE_ENV: 'production', OPENAI_API_KEY: 'sk-proj-x' } })
    expect(p).toBeInstanceOf(ApiEmbeddingProvider)
    expect(p.dim).toBe(1536) // dim follows the selected provider, not hardcoded downstream
  })

  it('resolves the key from the KeyStore too (Settings-saved key, no env var) — same store as chat', () => {
    const keyStore = { get: (provider: string): string | undefined => (provider === 'openai' ? 'sk-stored' : undefined) }
    const p = selectEmbeddingProvider({ env: { NODE_ENV: 'production' }, keyStore })
    expect(p).toBeInstanceOf(ApiEmbeddingProvider)
  })

  it('honors AKIS_EMBEDDING_MODEL override for the active dim', () => {
    const p = selectEmbeddingProvider({ env: { NODE_ENV: 'production', OPENAI_API_KEY: 'sk-x', AKIS_EMBEDDING_MODEL: 'text-embedding-3-large' } })
    expect(p).toBeInstanceOf(ApiEmbeddingProvider)
    expect(p.dim).toBe(3072)
  })

  it('a blank/whitespace env key is treated as ABSENT → stays on Local (parity with createProvider)', () => {
    const p = selectEmbeddingProvider({ env: { NODE_ENV: 'production', OPENAI_API_KEY: '   ' } })
    expect(p).toBeInstanceOf(LocalEmbeddingProvider)
  })
})
