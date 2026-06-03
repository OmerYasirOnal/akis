import type { Role } from '@akis/shared'

/**
 * The single source of truth for the AKIS core agents' display names. These are proper
 * nouns (brand/product names), so they stay literal rather than being translated — but
 * they live here once instead of being repeated as scattered string literals across the
 * roster, the pipeline, and the analytics dashboard.
 */
export const AGENT_NAMES: Record<Role, string> = {
  orchestrator: 'AKIS', // orchestrator = AKIS itself
  scribe: 'Scribe',
  proto: 'Proto',
  trace: 'Trace',
  critic: 'Critic',
}

/** Resolve a display name for an agent, falling back to the raw key for non-core
 *  (e.g. custom advisory) agents that have no fixed proper noun. */
export function agentName(role: string): string {
  return AGENT_NAMES[role as Role] ?? role
}
