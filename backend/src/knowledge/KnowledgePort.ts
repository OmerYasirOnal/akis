import type { KnowledgeChunk } from '@akis/shared'

export interface RetrieveQuery {
  query: string
  sessionId: string
  limit?: number
}

/**
 * The knowledge-retrieval seam that feeds SharedContext. Read-only: it grounds an
 * agent with prior knowledge but carries NO authority. The real (RAG) implementation
 * lands in the Auto-RAG sub-project behind this exact interface.
 */
export interface KnowledgePort {
  retrieve(q: RetrieveQuery): Promise<KnowledgeChunk[]>
}

/** Default until RAG lands: grounds nothing (so SharedContext works out of the box). */
export class NullKnowledgePort implements KnowledgePort {
  async retrieve(_q: RetrieveQuery): Promise<KnowledgeChunk[]> {
    return []
  }
}
