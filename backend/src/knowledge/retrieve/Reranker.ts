import type { Scored } from '../store/VectorStore.js'
import { tokenize } from '../ingest/tokenize.js'

/**
 * Pluggable second-stage reranker (issue #7 AC3). Runs AFTER hybrid fusion (rrfFuse)
 * over the fused candidate set, re-scoring against the query and returning a stable,
 * top-k ordering. Skippable (NoopReranker) and offline by default (LocalReranker) so
 * the stack stays self-hostable with no network/model. Mirrors the
 * EmbeddingProvider / LocalEmbeddingProvider seam: an API-backed cross-encoder drops
 * in behind this interface later without touching consumers.
 */
export interface Reranker {
  rerank(query: string, candidates: Scored[], k: number): Scored[]
}

/**
 * Offline, deterministic lexical-overlap reranker. Re-scores each candidate by the
 * cosine of the query/chunk term-frequency vectors (a bounded [0,1] lexical signal),
 * blended with a small carry-over of the prior fusion rank so a strong fusion result
 * is not discarded on a weak lexical tie. Same input → same output (no randomness, no
 * I/O). Ties (and empty-overlap queries) preserve the incoming order via a stable
 * sort, so it degrades to a no-op when it has no signal to add.
 */
export class LocalReranker implements Reranker {
  rerank(query: string, candidates: Scored[], k: number): Scored[] {
    if (candidates.length === 0) return []
    const qTf = termFreq(tokenize(query))
    // Decorate with the original index to make the sort provably stable.
    const decorated = candidates.map((c, i) => ({
      c,
      i,
      // Lexical overlap dominates; the prior fusion score breaks lexical ties without
      // overriding a clear lexical winner (fusion scores are << 1 in practice).
      key: lexicalCosine(qTf, c.stored.chunk.text) + c.score * 1e-3,
    }))
    decorated.sort((a, b) => (b.key - a.key) || (a.i - b.i))
    return decorated.slice(0, k).map(d => d.c)
  }
}

/** Identity reranker: preserves the incoming order, only enforcing top-k. Used when
 *  reranking is disabled, keeping the pipeline shape identical (skip, never crash). */
export class NoopReranker implements Reranker {
  rerank(_query: string, candidates: Scored[], k: number): Scored[] {
    return candidates.slice(0, k)
  }
}

function termFreq(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>()
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
  return tf
}

/** Cosine similarity of the query term-frequency vector against the candidate text's
 *  term-frequency vector. Bounded in [0,1]; 0 when there is no shared term. */
function lexicalCosine(qTf: Map<string, number>, text: string): number {
  const dTf = termFreq(tokenize(text))
  if (qTf.size === 0 || dTf.size === 0) return 0
  let dot = 0
  for (const [term, qf] of qTf) {
    const df = dTf.get(term)
    if (df) dot += qf * df
  }
  if (dot === 0) return 0
  let qNorm = 0
  for (const v of qTf.values()) qNorm += v * v
  let dNorm = 0
  for (const v of dTf.values()) dNorm += v * v
  return dot / (Math.sqrt(qNorm) * Math.sqrt(dNorm))
}
