import type { SharedContext } from '@akis/shared'

/**
 * Render the retrieved-knowledge slice of a SharedContext as a prompt suffix.
 * Empty (no chunks / no ctx) → '' so prompts are unchanged when nothing is
 * grounded (e.g. the NullKnowledgePort default, tests, keyless runs).
 */
export function renderKnowledge(ctx: SharedContext | undefined, limit = 6): string {
  const chunks = ctx?.knowledge ?? []
  if (chunks.length === 0) return ''
  const lines = chunks.slice(0, limit).map(c => `- (${c.source}) ${c.text}`)
  return `\n\nRELEVANT PRIOR KNOWLEDGE (grounding — use if helpful):\n${lines.join('\n')}`
}
