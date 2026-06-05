import type { KnowledgePort } from '../../knowledge/KnowledgePort.js'
import { ToolRegistry } from './ToolRegistry.js'
import { retrieveKnowledgeTool } from './retrieveKnowledgeTool.js'
import { buildGithubMcpTools, type GithubMcpDeps } from './githubMcpTools.js'

/**
 * The SINGLE choke point that translates an advisory agent's declared capabilities
 * into a concrete ToolRegistry. INVARIANT: only read-only / non-gate tools may ever
 * be wired here. Gate capabilities are already rejected upstream (AgentRegistry.register
 * + save-time validateWorkflowConfig), and any capability NOT in this allow-list
 * silently yields no tool (fail-closed). Add new advisory tools here so the allow-list
 * stays one declarative place rather than scattered `if` branches.
 */
export function buildAdvisoryTools(
  capabilities: ReadonlySet<string>,
  deps: { knowledge: KnowledgePort; sessionId: string },
): ToolRegistry {
  const tools = new ToolRegistry()
  if (capabilities.has('retrieve_knowledge')) {
    tools.register(retrieveKnowledgeTool({ knowledge: deps.knowledge, sessionId: deps.sessionId }))
  }
  return tools
}

/**
 * The SP1 super-set of buildAdvisoryTools that ALSO surfaces READ-ONLY GitHub-MCP tools when
 * a per-owner connection is present. It first builds the byte-identical RAG registry, then —
 * if `deps.githubMcp` is given — appends each `github_` read tool.
 *
 * FAIL-CLOSED / NO-CRASH: the github wiring is wrapped so that ANY failure (the pool throwing,
 * buildGithubMcpTools rejecting, OR ToolRegistry.register's duplicate-name throw) DISCARDS all
 * github tools and returns a registry byte-identical to buildAdvisoryTools. So a github failure
 * can never weaken or crash the RAG path. When github tools register cleanly, the registry holds
 * retrieve_knowledge (if the cap is set) PLUS the allow-listed `github_` reads and NOTHING else.
 */
export async function buildAdvisoryToolsWithGithub(
  capabilities: ReadonlySet<string>,
  deps: { knowledge: KnowledgePort; sessionId: string; githubMcp?: GithubMcpDeps },
): Promise<ToolRegistry> {
  const ragOnly = buildAdvisoryTools(capabilities, deps)
  if (!deps.githubMcp) return ragOnly

  let githubTools
  try {
    githubTools = await buildGithubMcpTools(deps.githubMcp)
  } catch {
    // buildGithubMcpTools never throws by contract, but be defensive: RAG-only on any escape.
    return ragOnly
  }
  if (githubTools.length === 0) return ragOnly

  // Register the github tools onto a SEPARATE registry; if any register throws (e.g. a
  // duplicate name), discard ALL github tools and return the untouched RAG-only registry.
  try {
    const merged = buildAdvisoryTools(capabilities, deps)
    for (const t of githubTools) merged.register(t)
    return merged
  } catch {
    return ragOnly
  }
}
