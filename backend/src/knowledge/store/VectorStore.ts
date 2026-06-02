import type { KnowledgeChunk } from '@akis/shared'

/** Server-stamped provenance carried by every chunk (F1-AC4). */
export interface ChunkMeta {
  source: string          // e.g. 'conversation' | 'agent' | 'repo' | 'upload'
  sourceId: string        // the originating id (sessionId, file path, ...)
  userId: string
  sessionId: string
  agent?: string
  createdAt: string
}

export interface StoredChunk {
  id: string              // contentHash — idempotent upsert key (F1-AC3)
  vector: number[]
  chunk: KnowledgeChunk
  meta: ChunkMeta
}

/** Tenancy scope applied INSIDE search so user A's chunks never reach user B (F1-AC5). */
export interface TenantFilter {
  userId: string
  sessionId?: string
}

export interface Scored {
  stored: StoredChunk
  score: number
}

export interface VectorStore {
  upsert(c: StoredChunk): void
  has(id: string): boolean
  search(vector: number[], filter: TenantFilter, k: number): Scored[]
  deleteBy(pred: (m: ChunkMeta) => boolean): number
  size(): number
}

/** True iff a chunk's provenance is visible under the tenant filter. */
export function matchesTenant(meta: ChunkMeta, filter: TenantFilter): boolean {
  if (meta.userId !== filter.userId) return false
  if (filter.sessionId !== undefined && meta.sessionId !== filter.sessionId) return false
  return true
}
