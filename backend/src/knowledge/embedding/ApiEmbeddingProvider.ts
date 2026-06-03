import type { EmbeddingProvider } from './EmbeddingProvider.js'
import { LocalEmbeddingProvider } from './EmbeddingProvider.js'
import { postJson, type PostOpts } from '../../agent/providers/http.js'
import { EMBEDDING_CATALOG, DEFAULT_EMBEDDING_MODEL, embeddingDimFor } from '../../agent/providers/catalog.js'

/** Optional key source consulted AFTER env (the encrypted KeyStore) — the SAME shape
 *  createProvider uses for the chat providers. No second key system. */
export interface KeyLookup {
  get(provider: string): string | undefined
}

export interface ApiEmbeddingOpts {
  apiKey: string
  /** An embedding model id from EMBEDDING_CATALOG; defaults to text-embedding-3-small (1536). */
  model?: string
  /** Override for an OpenAI-compatible embeddings endpoint (e.g. a proxy/self-host). */
  baseUrl?: string
  /** Injectable fetch for tests (mirrors the chat providers' seam). */
  fetchFn?: typeof fetch
}

/**
 * A REAL semantic embedding provider behind the {@link EmbeddingProvider} port — plain
 * `fetch` to the OpenAI embeddings endpoint (`POST /v1/embeddings`, `Authorization:
 * Bearer <key>`, body `{model, input}`). Selected ONLY when its key resolves; the offline
 * LocalEmbeddingProvider stays the keyless/test default (see {@link selectEmbeddingProvider}).
 *
 * The whole input array is sent as ONE batched request. Returned vectors are reordered by
 * `data[].index` (the API may return them out of order) and L2-normalized so cosine == dot
 * (matching what MemoryVectorStore assumes). `dim` follows the active model from the catalog
 * — downstream never hardcodes a dimension.
 *
 * SECURITY: the key travels ONLY as a request header (via postJson) and is NEVER logged or
 * returned; postJson never logs headers/bodies and an OpenAI error body never carries the key,
 * so a surfaced ProviderHttpError is safe.
 */
export class ApiEmbeddingProvider implements EmbeddingProvider {
  readonly dim: number
  private readonly model: string
  private readonly url: string
  private readonly apiKey: string
  private readonly opts: PostOpts

  constructor(cfg: ApiEmbeddingOpts) {
    this.apiKey = cfg.apiKey
    this.model = cfg.model ?? DEFAULT_EMBEDDING_MODEL
    this.dim = embeddingDimFor(this.model)
    const base = (cfg.baseUrl ?? EMBEDDING_CATALOG.openai.baseUrl).replace(/\/$/, '')
    this.url = `${base}/embeddings`
    this.opts = cfg.fetchFn ? { fetchFn: cfg.fetchFn } : {}
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [] // short-circuit: no request for an empty batch
    const res = await postJson<EmbeddingsResponse>(
      this.url,
      { model: this.model, input: texts },
      { authorization: `Bearer ${this.apiKey}` },
      this.opts,
    )
    // Reorder by index so vectors line up 1:1 with `texts`, then L2-normalize each.
    const out = new Array<number[]>(texts.length)
    for (const row of res.data ?? []) {
      if (typeof row.index === 'number' && row.index >= 0 && row.index < texts.length) {
        out[row.index] = l2normalize(row.embedding ?? [])
      }
    }
    // Defensive fill: any slot the API omitted becomes a safe zero vector (never undefined),
    // so a malformed response can't propagate `undefined` into the vector store.
    for (let i = 0; i < out.length; i++) if (!out[i]) out[i] = []
    return out
  }
}

interface EmbeddingsResponse {
  data?: { index?: number; embedding?: number[] }[]
}

/** L2-normalize so cosine == dot product; a zero vector stays zero (parity with the
 *  LocalEmbeddingProvider's normalization). */
function l2normalize(v: number[]): number[] {
  let norm = 0
  for (const x of v) norm += x * x
  norm = Math.sqrt(norm)
  if (norm === 0) return v
  return v.map(x => x / norm)
}

export interface SelectEmbeddingOpts {
  /** Env source for key + model selection (defaults to process.env). */
  env?: Record<string, string | undefined>
  /** The encrypted KeyStore (consulted after env) — the SAME store the chat providers use. */
  keyStore?: KeyLookup
}

/**
 * Select the embedding provider. The rule, mirroring createProvider's discipline:
 *
 *   - `NODE_ENV==='test'` → ALWAYS LocalEmbeddingProvider (offline, deterministic; the
 *     suite + golden eval never hit the network and never depend on a key).
 *   - else, resolve the OpenAI key (env `OPENAI_API_KEY` → KeyStore `openai`, the SAME
 *     sources as the chat provider; a blank/whitespace value is treated as ABSENT). A key
 *     present → ApiEmbeddingProvider (model from AKIS_EMBEDDING_MODEL, else the catalog
 *     default; an OPENAI_BASE_URL override is honored). No key → LocalEmbeddingProvider.
 *
 * This keeps the keyless/test boot path byte-for-byte identical to before (offline
 * embeddings) and is purely additive: a real embedder turns on the moment a key is supplied.
 * The key is read for resolution only and is NEVER logged or returned.
 */
export function selectEmbeddingProvider(opts: SelectEmbeddingOpts = {}): EmbeddingProvider {
  const env = opts.env ?? (process.env as Record<string, string | undefined>)
  if (env.NODE_ENV === 'test') return new LocalEmbeddingProvider()

  const apiKey = resolveEmbeddingKey(env, opts.keyStore)
  if (!apiKey) return new LocalEmbeddingProvider()

  const model = env.AKIS_EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL
  const baseUrl = env.OPENAI_BASE_URL?.trim()
  return new ApiEmbeddingProvider({ apiKey, model, ...(baseUrl ? { baseUrl } : {}) })
}

/** Resolve the OpenAI key for embeddings from the SAME sources as the chat provider: the
 *  catalog's per-provider env vars first, then the KeyStore (provider id `openai`). A
 *  blank/whitespace value is ABSENT (parity with createProvider.firstPresentKey). */
function resolveEmbeddingKey(env: Record<string, string | undefined>, keyStore?: KeyLookup): string | undefined {
  // OPENAI_API_KEY is the catalog's openai keyEnvVar; reuse that identity rather than a new var.
  const fromEnv = env.OPENAI_API_KEY?.trim()
  if (fromEnv) return fromEnv
  const fromStore = keyStore?.get('openai')?.trim()
  if (fromStore) return fromStore
  return undefined
}
