import { type StoredChunk, type TenantFilter, type Scored, type ChunkMeta, matchesTenant } from './VectorStore.js'
import { tokenize } from '../ingest/tokenize.js'

const K1 = 1.5
const B = 0.75

interface Doc { stored: StoredChunk; tokens: string[]; len: number; tf: Map<string, number> }

/**
 * In-memory BM25 lexical index over the same chunks, tenancy-filtered (F1-AC5).
 * Complements the vector store: exact-term matches the embedding may miss. IDF/avgdl
 * are computed at query time from the current corpus (small MVP corpus).
 */
export class Bm25Index {
  private docs = new Map<string, Doc>()

  add(stored: StoredChunk): void {
    const tokens = tokenize(stored.chunk.text)
    const tf = new Map<string, number>()
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
    this.docs.set(stored.id, { stored, tokens, len: tokens.length, tf })
  }

  /**
   * Rebuild the lexical index from a persisted corpus on boot — the durable other half of
   * hybrid retrieval. Without this the index is reconstructed EMPTY on every restart (a Pg
   * deployment silently loses BM25, so RRF degrades to vector-only and exact-term recall
   * disappears). The chunks come from the SAME `vector_chunks` rows {@link PgVectorStore}
   * hydrates, in the SAME seq order, so the rehydrated index is identical to the live one.
   * Re-tokenizes via {@link add} (no separate postings table to drift) — idempotent: a
   * repeat hydrate re-adds the same ids.
   */
  hydrate(chunks: Iterable<StoredChunk>): void {
    for (const c of chunks) this.add(c)
  }

  /** Corpus size — used to assert the rehydrated index matches the vector store after boot. */
  size(): number {
    return this.docs.size
  }

  deleteBy(pred: (m: ChunkMeta) => boolean): number {
    let n = 0
    for (const [id, d] of this.docs) {
      if (pred(d.stored.meta)) { this.docs.delete(id); n++ }
    }
    return n
  }

  search(query: string, filter: TenantFilter, k: number): Scored[] {
    const visible = [...this.docs.values()].filter(d => matchesTenant(d.stored.meta, filter))
    if (visible.length === 0) return []
    const avgdl = visible.reduce((s, d) => s + d.len, 0) / visible.length
    const qTerms = [...new Set(tokenize(query))]

    // df per query term, over the visible corpus.
    const df = new Map<string, number>()
    for (const term of qTerms) {
      df.set(term, visible.filter(d => d.tf.has(term)).length)
    }

    const scored: Scored[] = visible.map(d => {
      let score = 0
      for (const term of qTerms) {
        const f = d.tf.get(term)
        if (!f) continue
        const n = df.get(term)!
        const idf = Math.log(1 + (visible.length - n + 0.5) / (n + 0.5))
        const denom = f + K1 * (1 - B + (B * d.len) / avgdl)
        score += idf * ((f * (K1 + 1)) / denom)
      }
      return { stored: d.stored, score }
    })
    return scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, k)
  }
}
