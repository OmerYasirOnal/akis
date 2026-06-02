import type { KnowledgeChunk } from '@akis/shared'

export interface RetrieveQuery {
  query: string
  sessionId: string
  limit?: number
  /** Optional second-stage rerank toggle (issue #7 AC3). Omitted → the RAG
   *  implementation's default (on). A skippable quality knob, never a gate. */
  rerank?: boolean
}

/**
 * The knowledge-retrieval seam that feeds SharedContext. Read-only: it grounds an
 * agent with prior knowledge but carries NO authority. The real (RAG) implementation
 * lands in the Auto-RAG sub-project behind this exact interface.
 *
 * TRUST BOUNDARY (implementer's responsibility):
 * - `q.query` is built from UNTRUSTED input (the user's idea / LLM-generated spec).
 *   An implementation must handle arbitrary strings safely (escape DB/API params;
 *   never interpolate the query into an unescaped backend call).
 * - Returned `KnowledgeChunk.text` is embedded into LLM prompts by the agents, so an
 *   implementation MUST return trusted/sanitized text — chunks must not carry
 *   prompt-injection / instruction-override content. The retrieval layer owns this;
 *   the orchestrator treats chunks as already-trusted grounding.
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
