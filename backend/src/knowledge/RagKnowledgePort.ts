import type { KnowledgeChunk } from '@akis/shared'
import type { KnowledgePort, RetrieveQuery } from './KnowledgePort.js'
import type { RagService } from './RagService.js'

/**
 * The real KnowledgePort backed by RagService — read-only (F1-AC9), holds no gate
 * capability. This replaces NullKnowledgePort in SharedContext when RAG is on.
 *
 * Tenancy: a RetrieveQuery has no userId (the SharedContext seam is per-session),
 * so the port is constructed with a userId resolver (single-user MVP → a constant);
 * retrieval is always scoped to {userId, sessionId}.
 */
export class RagKnowledgePort implements KnowledgePort {
  constructor(private rag: RagService, private userIdFor: (sessionId: string) => string) {}

  async retrieve(q: RetrieveQuery): Promise<KnowledgeChunk[]> {
    return this.rag.retrieve(q.query, { userId: this.userIdFor(q.sessionId), sessionId: q.sessionId }, q.limit ?? 6)
  }
}
