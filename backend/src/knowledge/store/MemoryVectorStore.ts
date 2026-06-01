import { type VectorStore, type StoredChunk, type TenantFilter, type Scored, type ChunkMeta, matchesTenant } from './VectorStore.js'

/** Dot product. Vectors are L2-normalized by the embedder, so this is cosine. */
function dot(a: number[], b: number[]): number {
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!
  return s
}

/**
 * In-memory vector store keyed by chunk id (contentHash) → idempotent upsert
 * (F1-AC3). Search is tenancy-filtered (F1-AC5) cosine top-k. A pgvector-backed
 * store drops in behind the VectorStore interface later (F1-AC6, deferred).
 */
export class MemoryVectorStore implements VectorStore {
  private byId = new Map<string, StoredChunk>()

  upsert(c: StoredChunk): void {
    this.byId.set(c.id, c)
  }

  has(id: string): boolean {
    return this.byId.has(id)
  }

  search(vector: number[], filter: TenantFilter, k: number): Scored[] {
    if (this.byId.size === 0) return []
    const scored: Scored[] = []
    for (const stored of this.byId.values()) {
      if (!matchesTenant(stored.meta, filter)) continue
      scored.push({ stored, score: dot(vector, stored.vector) })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, k)
  }

  deleteBy(pred: (m: ChunkMeta) => boolean): number {
    let n = 0
    for (const [id, c] of this.byId) {
      if (pred(c.meta)) { this.byId.delete(id); n++ }
    }
    return n
  }

  size(): number {
    return this.byId.size
  }
}
