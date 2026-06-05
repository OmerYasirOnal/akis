import type { RegisteredTool } from './ToolRegistry.js'
import type { McpSessionPool } from '../mcp/McpSessionPool.js'
import { buildGithubMcpToolsFromTransport, type McpDiagnostic } from '../mcp/McpToolBridge.js'
import { McpUnavailableError } from '../mcp/McpTransport.js'

/** The just-in-time MCP wiring deps. The caller hands the ALREADY-DECRYPTED token — this
 *  module NEVER decrypts and NEVER persists it. */
export interface GithubMcpDeps {
  pool: McpSessionPool
  ownerId: string
  /** The session owner's decrypted GitHub OAuth token (just-in-time; never logged here). */
  token: string
  /** Non-secret degrade-reason sink (names/reasons only). Defaults to console.warn. */
  diag?: McpDiagnostic
}

const defaultDiag: McpDiagnostic = msg => {
  // eslint-disable-next-line no-console
  console.warn(msg)
}

/**
 * The SP1 analogue of retrieveKnowledgeTool's wiring: acquire a per-(ownerId, token) transport
 * from the pool, bridge its READ-ONLY tools, and return the `github_` RegisteredTool[].
 *
 * HONEST ABSENCE, NEVER A CRASH: any error — no Docker, bad token, server start failure
 * (McpUnavailableError), a listTools failure, or an empty allow-list intersection — yields [].
 * A single non-secret degrade-reason diagnostic is emitted per acquire (no token, ever). The
 * build is unaffected: the agent simply gets no github tools.
 */
export async function buildGithubMcpTools(deps: GithubMcpDeps): Promise<RegisteredTool[]> {
  const diag = deps.diag ?? defaultDiag
  let transport
  try {
    transport = await deps.pool.acquire(deps.ownerId, deps.token)
  } catch (e) {
    diag(`github-mcp: tools unavailable (${reasonOf(e)})`)
    return []
  }
  try {
    const tools = await buildGithubMcpToolsFromTransport(transport, diag)
    if (tools.length === 0) diag('github-mcp: no read tools available (empty-intersection)')
    return tools
  } catch (e) {
    // Defensive: the bridge already swallows listTools failures, but never let anything escape.
    diag(`github-mcp: tools unavailable (${reasonOf(e)})`)
    return []
  } finally {
    // We acquired a ref purely to BUILD the tool specs; release it. The pool keeps the
    // transport alive across the (synchronous) tool-loop turn via its idle window, and each
    // tool HANDLER re-uses the same live transport instance captured by the bridge closure.
    deps.pool.release(deps.ownerId, deps.token)
  }
}

/** Map an error to a short, NON-SECRET degrade reason. Never echoes a token or args. */
function reasonOf(e: unknown): string {
  if (e instanceof McpUnavailableError) {
    if (e.message.includes('docker')) return 'no-docker'
    return 'server-error'
  }
  return 'connection-absent'
}
