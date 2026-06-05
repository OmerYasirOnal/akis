import type { RegisteredTool } from '../tools/ToolRegistry.js'
import type { McpToolInfo, McpTransport } from './McpTransport.js'
import { GITHUB_READONLY_TOOLS, isReadOnlyTool } from './readOnlyAllowlist.js'

/** The namespace every GitHub-MCP tool is exposed under, so it can never collide with a
 *  first-party advisory tool (e.g. retrieve_knowledge) in the registry. */
const NS = 'github_'

/** A non-secret diagnostic sink (names/counts only — NEVER the token). Defaults to console.warn. */
export type McpDiagnostic = (msg: string) => void

const defaultDiag: McpDiagnostic = msg => {
  // eslint-disable-next-line no-console
  console.warn(msg)
}

/**
 * GATE-SAFETY bridge: turn a connected, INITIALIZED transport's advertised tools into
 * `RegisteredTool[]`, admitting ONLY names on the positive read-only allow-list
 * (GITHUB_READONLY_TOOLS) — independent of the server's own --read-only flag. A write tool
 * name (push_files / create_or_update_file / merge_pull_request / …) is structurally absent
 * from the set and therefore can NEVER register.
 *
 * Robustness (matches toolLoop/retrieveKnowledge contract):
 *  - listTools() failure ⇒ returns [] (never throws).
 *  - empty intersection ⇒ returns [] (the agent simply gets no github tools).
 *  - a callTool reject ⇒ the handler returns an Error STRING (never throws into the loop).
 *
 * OBSERVABILITY: emits a LOUD, name-only diagnostic when the server advertises tools that
 * are NOT on the allow-list (so image name-drift is caught at boot/CI) — never the token.
 */
export async function buildGithubMcpToolsFromTransport(
  transport: McpTransport,
  diag: McpDiagnostic = defaultDiag,
): Promise<RegisteredTool[]> {
  let advertised: McpToolInfo[]
  try {
    advertised = await transport.listTools()
  } catch {
    // Honest absence: a listTools failure ⇒ no github tools, never a crash.
    return []
  }

  const admitted = advertised.filter(t => isReadOnlyTool(t.name))
  const dropped = advertised.filter(t => !isReadOnlyTool(t.name)).map(t => t.name)
  if (dropped.length > 0) {
    // Name-drift / write-tool surface diagnostic. Names only — never the token, never args.
    diag(
      `github-mcp: dropped ${dropped.length} non-allowlisted tool(s) [${dropped.join(', ')}]; ` +
        `allow-list has ${GITHUB_READONLY_TOOLS.size} read tools`,
    )
  }
  if (admitted.length === 0) return []

  return admitted.map(info => bridgeTool(transport, info))
}

/** Wrap one allow-listed MCP tool as a RegisteredTool. The handler returns the call's text;
 *  on a transport/server reject it returns an Error STRING (never throws). */
function bridgeTool(transport: McpTransport, info: McpToolInfo): RegisteredTool {
  return {
    spec: {
      name: `${NS}${info.name}`,
      description: info.description,
      schema: info.inputSchema,
    },
    handler: async (args: unknown): Promise<string> => {
      try {
        const res = await transport.callTool(info.name, args)
        if (res.isError) return `Error: github tool '${info.name}' returned an error: ${res.text}`
        return res.text
      } catch (e) {
        return `Error calling github tool '${info.name}': ${e instanceof Error ? e.message : String(e)}`
      }
    },
  }
}
