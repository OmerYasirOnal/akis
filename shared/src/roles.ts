export type Role = 'orchestrator' | 'scribe' | 'proto' | 'trace' | 'critic'

/** Trace is the only verifier. */
export const VERIFIER_ROLE: Role = 'trace'

export type ToolName =
  | 'dispatch_scribe' | 'dispatch_proto' | 'dispatch_trace' | 'dispatch_critic'
  | 'run_tests'
  | 'request_spec_approval' | 'request_push_confirm'
  | 'push_to_github'
  | 'retrieve_knowledge' // read-only RAG grounding; NOT a gate tool (see GATE_TOOLS)
  | 'ask' | 'chat'
  // SP1: read-only GitHub-via-MCP bridge surfaces an OPEN, runtime-discovered family of tools,
  // each namespaced `github_<server_tool>` (see McpToolBridge NS). Their names can't be enumerated
  // as literals — they come from the MCP server's advertised toolset. This is a DISPLAY/correlation
  // identifier on tool_call/tool_result events ONLY; it carries ZERO gate authority (gate caps live
  // in GATE_TOOLS, untouched). The fixed core literals above stay intact so the roster keeps its
  // exhaustiveness/autocomplete; the template member just admits the bridge's namespaced names.
  | `github_${string}`

/** The code-defined core roster (F2-AC2). The gates key on these; they're
 *  configurable (model/skills/prompt variant) but not redefinable/removable. */
export const CORE_ROLES: readonly Role[] = ['orchestrator', 'scribe', 'proto', 'trace', 'critic']
export function isCoreRole(r: string): r is Role {
  return (CORE_ROLES as readonly string[]).includes(r)
}

/** Tools that ARE gate capabilities — granting one to a non-owner role breaks a gate
 *  (F2-AC3/AC4/AC5). The owner is structural, not configurable. */
export const GATE_TOOLS = ['run_tests', 'push_to_github', 'dispatch_trace', 'request_spec_approval', 'request_push_confirm'] as const
export type GateTool = typeof GATE_TOOLS[number]
export const GATE_TOOL_OWNER: Record<GateTool, Role> = {
  run_tests: 'trace',               // only the verifier runs tests (producer≠verifier)
  dispatch_trace: 'orchestrator',   // only AKIS dispatches the verifier
  push_to_github: 'orchestrator',   // push happens behind the push gate, via AKIS
  request_spec_approval: 'orchestrator',
  request_push_confirm: 'orchestrator',
}
export function isGateTool(t: string): t is GateTool {
  return (GATE_TOOLS as readonly string[]).includes(t)
}
