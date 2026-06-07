import type { KnowledgePort } from '../../knowledge/KnowledgePort.js'
import type { RegisteredTool } from './ToolRegistry.js'
import { ToolRegistry } from './ToolRegistry.js'
import { retrieveKnowledgeTool } from './retrieveKnowledgeTool.js'
import { buildGithubMcpTools, type GithubMcpDeps } from './githubMcpTools.js'
import { buildAtlassianMcpTools, type AtlassianMcpDeps } from './atlassianMcpTools.js'

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
  // `knowledge` is OPTIONAL: it is consulted ONLY for the retrieve_knowledge capability. A
  // github-only caller (RAG off) passes no knowledge port and gets a registry with no RAG tool —
  // so a producer can surface read-only github_ tools WITHOUT RAG being enabled.
  deps: { knowledge?: KnowledgePort; sessionId: string },
): ToolRegistry {
  const tools = new ToolRegistry()
  if (capabilities.has('retrieve_knowledge') && deps.knowledge) {
    tools.register(retrieveKnowledgeTool({ knowledge: deps.knowledge, sessionId: deps.sessionId }))
  }
  return tools
}

/** A no-op release — the disposer returned whenever no GitHub-MCP ref is held (RAG-only path),
 *  so the caller can ALWAYS call `release()` in a finally without a presence check. */
const NOOP_RELEASE = (): void => {}

/** What buildAdvisoryToolsWithGithub returns: the merged registry PLUS a `release` disposer the
 *  caller MUST call once the tool LOOP that uses the registry has finished. On the RAG-only path
 *  (no connection / github failed / no tools) release is a no-op. When github tools registered,
 *  release frees the held pool ref — see GithubMcpToolsResult.release: the ref is held for the
 *  loop's lifetime so the pool's idle timer can never close the live Docker child mid-loop. */
export interface AdvisoryToolsWithGithub {
  registry: ToolRegistry
  release: () => void
}

/**
 * The SP1 super-set of buildAdvisoryTools that ALSO surfaces READ-ONLY GitHub-MCP tools when
 * a per-owner connection is present. It first builds the byte-identical RAG registry, then —
 * if `deps.githubMcp` is given — appends each `github_` read tool.
 *
 * FAIL-CLOSED / NO-CRASH: the github wiring is wrapped so that ANY failure (the pool throwing,
 * buildGithubMcpTools rejecting, OR ToolRegistry.register's duplicate-name throw) DISCARDS all
 * github tools and returns a registry byte-identical to buildAdvisoryTools (with a no-op release).
 * So a github failure can never weaken or crash the RAG path. When github tools register cleanly,
 * the registry holds retrieve_knowledge (if the cap is set) PLUS the allow-listed `github_` reads
 * and NOTHING else, and the returned `release` frees the held pool ref AFTER the loop finishes.
 *
 * REF LIFECYCLE (findings #4/#6): buildGithubMcpTools holds ONE pool ref across the loop; that ref
 * is surfaced here as `release`. The caller (ScribeAgent) MUST call release in a finally around
 * callWithTools. Every early-return below releases the (possibly-held) ref itself so a github ref
 * is never leaked on a fail-closed branch.
 */
export async function buildAdvisoryToolsWithGithub(
  capabilities: ReadonlySet<string>,
  deps: { knowledge?: KnowledgePort; sessionId: string; githubMcp?: GithubMcpDeps; atlassianMcp?: AtlassianMcpDeps },
): Promise<AdvisoryToolsWithGithub> {
  const ragOnly = buildAdvisoryTools(capabilities, deps)
  if (!deps.githubMcp && !deps.atlassianMcp) return { registry: ragOnly, release: NOOP_RELEASE }

  // Build EACH present MCP source FAIL-CLOSED + INDEPENDENTLY: a source that throws or yields no tools
  // contributes nothing and holds no ref. Each returns its own `release` (github frees a pool ref;
  // atlassian closes the HTTP transport) — both held for the loop's lifetime, freed together below.
  const built: { tools: RegisteredTool[]; release: () => void }[] = []
  if (deps.githubMcp) {
    try { built.push(await buildGithubMcpTools(deps.githubMcp)) } catch { /* defensive: RAG-only for this source */ }
  }
  if (deps.atlassianMcp) {
    try { built.push(await buildAtlassianMcpTools(deps.atlassianMcp)) } catch { /* defensive: RAG-only for this source */ }
  }
  const releaseAll = (): void => { for (const b of built) b.release() } // each release is idempotent
  const allTools = built.flatMap(b => b.tools)
  if (allTools.length === 0) { releaseAll(); return { registry: ragOnly, release: NOOP_RELEASE } }

  // Register the MCP read tools onto a SEPARATE registry; if any register throws (e.g. a duplicate
  // name across sources), discard ALL of them, RELEASE every held ref, and return the RAG-only registry.
  try {
    const merged = buildAdvisoryTools(capabilities, deps)
    for (const t of allTools) merged.register(t)
    return { registry: merged, release: releaseAll }
  } catch {
    releaseAll()
    return { registry: ragOnly, release: NOOP_RELEASE }
  }
}
