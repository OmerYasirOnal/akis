import type { Scored } from '../store/VectorStore.js'

const RRF_K = 60

/**
 * Reciprocal Rank Fusion of two ranked lists. Each list contributes 1/(k+rank) per
 * doc; scores sum across lists, so a doc strong in EITHER modality (vector or BM25)
 * surfaces, and one strong in both ranks highest. Rank-based fusion sidesteps the
 * incomparable score scales of cosine vs BM25.
 */
export function rrfFuse(lists: Scored[][], topK: number): Scored[] {
  const acc = new Map<string, { stored: Scored['stored']; score: number }>()
  for (const list of lists) {
    list.forEach((s, rank) => {
      const id = s.stored.id
      const prev = acc.get(id)
      const contrib = 1 / (RRF_K + rank + 1)
      if (prev) prev.score += contrib
      else acc.set(id, { stored: s.stored, score: contrib })
    })
  }
  return [...acc.values()].sort((a, b) => b.score - a.score).slice(0, topK)
}
