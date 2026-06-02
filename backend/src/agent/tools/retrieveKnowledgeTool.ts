import type { KnowledgePort } from '../../knowledge/KnowledgePort.js'
import type { RegisteredTool } from './ToolRegistry.js'

export interface RetrieveKnowledgeDeps {
  knowledge: KnowledgePort
  /** Bound to the session so retrieval stays tenancy-scoped (the port resolves the user). */
  sessionId: string
  /** Max chunks to return (passed straight to the port). */
  limit?: number
}

const SCHEMA = {
  type: 'object',
  properties: { query: { type: 'string', description: 'What to look up in the project knowledge base.' } },
  required: ['query'],
  additionalProperties: false,
} as const

/**
 * The LLM-callable `retrieve_knowledge` tool: a thin, read-only wrapper over the
 * existing KnowledgePort (RAG). It lets an agent fetch grounding ON DEMAND mid-turn
 * — complementing the pre-assembled SharedContext — without any gate authority.
 *
 * Safety: the query is validated (must be a non-empty string), and retrieval errors
 * degrade to an error string fed back to the model rather than throwing. The port
 * owns the trust boundary on the returned text (see KnowledgePort docs).
 */
export function retrieveKnowledgeTool(deps: RetrieveKnowledgeDeps): RegisteredTool {
  return {
    spec: {
      name: 'retrieve_knowledge',
      description: 'Search the project knowledge base for relevant prior context. Returns a few short, sourced snippets.',
      schema: SCHEMA,
    },
    handler: async (args: unknown): Promise<string> => {
      const query = (args as { query?: unknown } | null)?.query
      if (typeof query !== 'string' || query.trim() === '') return "Error: 'query' must be a non-empty string."
      try {
        const chunks = await deps.knowledge.retrieve({
          query,
          sessionId: deps.sessionId,
          ...(deps.limit !== undefined ? { limit: deps.limit } : {}),
        })
        if (chunks.length === 0) return 'No relevant knowledge found.'
        return chunks.map(c => `- (${c.source}, ${c.score.toFixed(2)}) ${c.text}`).join('\n')
      } catch (e) {
        return `Error retrieving knowledge: ${e instanceof Error ? e.message : String(e)}`
      }
    },
  }
}
