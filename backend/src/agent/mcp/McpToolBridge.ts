import type { RegisteredTool } from '../tools/ToolRegistry.js'
import type { McpToolInfo, McpTransport } from './McpTransport.js'
import { GITHUB_READONLY_TOOLS, isReadOnlyTool, ATLASSIAN_READONLY_TOOLS, isAtlassianReadTool } from './readOnlyAllowlist.js'

/** Max chars of a single tool result fed back into the LLM loop (finding #11). A read like
 *  get_file_contents / getConfluencePage returns a WHOLE document that would otherwise flood the
 *  model context and spike token cost/quota. We cap here at the bridge so EVERY bridged tool inherits
 *  the bound, then append a clear truncation marker so the model knows the payload was cut. */
const MAX_RESULT_CHARS = 16_000

/** Cap a tool-result string to the budget, appending an explicit, model-readable truncation marker. */
function boundResult(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text
  return `${text.slice(0, MAX_RESULT_CHARS)}\n…[truncated: tool output exceeded ${MAX_RESULT_CHARS} chars]`
}

/** A non-secret diagnostic sink (names/counts only — NEVER the token). Defaults to console.warn. */
export type McpDiagnostic = (msg: string) => void

const defaultDiag: McpDiagnostic = msg => {
  // eslint-disable-next-line no-console
  console.warn(msg)
}

/** What the generic read bridge needs: a registry NAMESPACE (collision-free prefix), the positive
 *  read-only ALLOW-LIST predicate, a human LABEL (diagnostics + error strings), and the allow-list
 *  SIZE (the drift diagnostic). */
export interface McpReadBridgeOpts {
  namespace: string
  isAllowed: (name: string) => boolean
  label: string
  allowSize: number
}

/**
 * GATE-SAFETY bridge (provider-agnostic): turn a connected, INITIALIZED transport's advertised tools
 * into `RegisteredTool[]`, admitting ONLY names on the positive read-only allow-list. A write/mutation
 * tool is structurally ABSENT from the set and can therefore NEVER register — independent of the
 * server's own flags. Remote content surfaced here is EPHEMERAL grounding (a tool_result), never
 * RAG-ingested as trusted knowledge.
 *
 * Robustness: listTools() failure ⇒ [] (never throws); empty intersection ⇒ [] (no tools); a callTool
 * reject ⇒ the handler returns an Error STRING (never throws into the loop).
 *
 * LIVE-DISCOVERY HARNESS: the dropped-tool diagnostic logs the server's advertised-but-not-allowed
 * names (token-free) — exactly how an owner discovers a new provider's REAL tool names to reconcile
 * its allow-list (e.g. pinning the Atlassian set against a live connection).
 */
export async function buildMcpReadTools(
  transport: McpTransport,
  opts: McpReadBridgeOpts,
  diag: McpDiagnostic = defaultDiag,
): Promise<RegisteredTool[]> {
  let advertised: McpToolInfo[]
  try {
    advertised = await transport.listTools()
  } catch {
    return [] // honest absence — never a crash
  }
  const admitted = advertised.filter(t => opts.isAllowed(t.name))
  const dropped = advertised.filter(t => !opts.isAllowed(t.name)).map(t => t.name)
  if (dropped.length > 0) {
    // Name-drift / write-surface + LIVE-DISCOVERY diagnostic. Names only — never the token, never args.
    diag(`${opts.label}: dropped ${dropped.length} non-allowlisted tool(s) [${dropped.join(', ')}]; allow-list has ${opts.allowSize} read tools`)
  }
  if (admitted.length === 0) return []
  return admitted.map(info => bridgeTool(transport, info, opts.namespace, opts.label))
}

/** GitHub-MCP read tools (stdio+Docker). Thin wrapper over the generic bridge. */
export async function buildGithubMcpToolsFromTransport(transport: McpTransport, diag: McpDiagnostic = defaultDiag): Promise<RegisteredTool[]> {
  return buildMcpReadTools(transport, { namespace: 'github_', isAllowed: isReadOnlyTool, label: 'github-mcp', allowSize: GITHUB_READONLY_TOOLS.size }, diag)
}

/** Atlassian (Jira/Confluence) remote-MCP read tools for grounding. Thin wrapper over the generic
 *  bridge with the Atlassian read allow-list. Writes never come through here (external-write gate). */
export async function buildAtlassianMcpReadTools(transport: McpTransport, diag: McpDiagnostic = defaultDiag): Promise<RegisteredTool[]> {
  return buildMcpReadTools(transport, { namespace: 'atlassian_', isAllowed: isAtlassianReadTool, label: 'atlassian-mcp', allowSize: ATLASSIAN_READONLY_TOOLS.size }, diag)
}

/** Wrap one allow-listed MCP tool as a RegisteredTool. The handler returns the call's text; on a
 *  transport/server reject it returns an Error STRING (never throws). */
function bridgeTool(transport: McpTransport, info: McpToolInfo, namespace: string, label: string): RegisteredTool {
  return {
    spec: {
      name: `${namespace}${info.name}`,
      description: info.description,
      schema: info.inputSchema,
    },
    handler: async (args: unknown): Promise<string> => {
      try {
        const res = await transport.callTool(info.name, args)
        if (res.isError) return `Error: ${label} tool '${info.name}' returned an error: ${boundResult(res.text)}`
        return boundResult(res.text) // BOUND the payload — a single large read must not flood the LLM context
      } catch (e) {
        return `Error calling ${label} tool '${info.name}': ${e instanceof Error ? e.message : String(e)}`
      }
    },
  }
}
