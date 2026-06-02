import type { KnowledgePort } from '../../knowledge/KnowledgePort.js'
import { ToolRegistry } from './ToolRegistry.js'
import { retrieveKnowledgeTool } from './retrieveKnowledgeTool.js'

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
