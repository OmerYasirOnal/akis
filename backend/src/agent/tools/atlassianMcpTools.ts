import type { RegisteredTool } from './ToolRegistry.js'
import type { McpTransport } from '../mcp/McpTransport.js'
import { buildAtlassianMcpReadTools, type McpDiagnostic } from '../mcp/McpToolBridge.js'

/** The just-in-time Atlassian-MCP wiring deps. The caller (the DI resolver) hands an ALREADY-BUILT
 *  but NOT-yet-initialized transport (an HttpMcpTransport bound to the owner's OAuth provider). This
 *  module NEVER touches the token — it only drives the McpTransport seam. */
export interface AtlassianMcpDeps {
  transport: McpTransport
  /** Non-secret degrade-reason sink (names/reasons only). Defaults to console.warn. */
  diag?: McpDiagnostic
}

const defaultDiag: McpDiagnostic = msg => {
  // eslint-disable-next-line no-console
  console.warn(msg)
}

/** A no-op release — returned whenever no transport is held (no connection / build failed), so a
 *  caller can ALWAYS call `release()` in a finally without a presence check. Idempotent. */
const NOOP_RELEASE = (): void => {}

/** What buildAtlassianMcpTools returns: the bridged READ tools PLUS a `release` disposer the caller
 *  MUST call once the tool LOOP that uses them has finished — it closes the HTTP transport. */
export interface AtlassianMcpToolsResult {
  tools: RegisteredTool[]
  /** Close the transport EXACTLY once after the tool loop completes. Idempotent (double-call safe). */
  release: () => void
}

/**
 * The Atlassian analogue of buildGithubMcpTools: initialize the per-owner HTTP transport, bridge its
 * READ-ONLY tools (the frozen ATLASSIAN_READONLY_TOOLS allow-list — writes can NEVER surface here;
 * they flow only through the human-confirmed external-write gate), and return them WITH a `release`
 * disposer that closes the transport after the loop.
 *
 * Unlike the github-stdio path there is NO pool — an HTTP transport is cheap + stateless per build, so
 * we initialize one, hold it for the loop's lifetime (the bridged handlers capture it), and close it
 * on release. The transport is initialized HERE (the bridge contract wants an already-initialized
 * transport); a separate close-per-build keeps no idle connection open.
 *
 * HONEST ABSENCE, NEVER A CRASH: any failure — initialize reject, listTools failure, empty allow-list
 * intersection — yields `{ tools: [], release: noop }` and a single non-secret diagnostic (never the
 * token). On the no-tools paths the transport is closed immediately (there is no loop to hold it for).
 * Remote content surfaced here is EPHEMERAL grounding (a tool_result) — never RAG-ingested.
 */
export async function buildAtlassianMcpTools(deps: AtlassianMcpDeps): Promise<AtlassianMcpToolsResult> {
  const diag = deps.diag ?? defaultDiag
  // close() is idempotent per the McpTransport contract, so it is safe to call on any terminal path —
  // including a FAILED initialize (a half-open HTTP connection must still be torn down, not leaked).
  const close = (): void => { void deps.transport.close().catch(() => {}) }
  try {
    await deps.transport.initialize()
  } catch {
    diag('atlassian-mcp: tools unavailable (connection/init failed)')
    close()
    return { tools: [], release: NOOP_RELEASE }
  }
  try {
    const tools = await buildAtlassianMcpReadTools(deps.transport, diag)
    if (tools.length === 0) {
      diag('atlassian-mcp: no read tools available (empty-intersection)')
      close()
      return { tools: [], release: NOOP_RELEASE }
    }
    // Tools exist: HOLD the transport for the loop's lifetime; the caller releases (closes) it after.
    let released = false
    return { tools, release: (): void => { if (released) return; released = true; close() } }
  } catch {
    diag('atlassian-mcp: tools unavailable (bridge error)')
    close()
    return { tools: [], release: NOOP_RELEASE }
  }
}
