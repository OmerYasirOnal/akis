import { type StoredChunk, type TenantFilter, type Scored, type ChunkMeta, matchesTenant } from './VectorStore.js'

const K1 = 1.5
const B = 0.75

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

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
