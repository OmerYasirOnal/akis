import { isCoreRole, type AgentConfig, type Role, type WorkflowConfig } from '@akis/shared'
import type { ProviderId } from '../agent/providers/catalog.js'

export interface AgentModel { provider: ProviderId; model?: string }

/**
 * Resolve a saved WorkflowConfig into the per-agent {provider, model} map that
 * buildServices binds at session start (F2-AC9). Only CORE roles with an explicit
 * model are mapped; custom roles and model-less agents fall through to the default
 * provider. Pure — no new control flow, gates untouched.
 */
export function workflowToAgentModels(wf: WorkflowConfig): Partial<Record<Role, AgentModel>> {
  const out: Partial<Record<Role, AgentModel>> = {}
  for (const a of wf.agents) {
    if (isCoreRole(a.role) && a.model?.providerId) {
      // Only emit a model when it's a NON-EMPTY id — an empty "(default)" picker value
      // must NOT reach the provider as model:"" (real APIs 400 on an empty model string).
      out[a.role] = { provider: a.model.providerId as ProviderId, ...(a.model.modelId ? { model: a.model.modelId } : {}) }
    }
  }
  return out
}

/**
 * Resolve a saved WorkflowConfig into the per-agent skill-NAME map that buildServices
 * injects into each core agent's system prompt (P3-AGENT-1). Only CORE roles with a
 * non-empty `skills` list are mapped; custom roles and skill-less agents fall through
 * (their prompt stays the byte-identical base). Pure — no new control flow, gates
 * untouched. The names are resolved against the loaded skill registry inside
 * buildServices; an unknown name is simply dropped there (never a throw).
 */
export function workflowToAgentSkills(wf: WorkflowConfig): Partial<Record<Role, string[]>> {
  const out: Partial<Record<Role, string[]>> = {}
  for (const a of wf.agents) {
    if (isCoreRole(a.role) && a.skills && a.skills.length > 0) {
      out[a.role] = [...a.skills]
    }
  }
  return out
}

/**
 * The NON-core (custom) agents of a workflow — the advisory agents AKIS dispatches
 * at the pipeline EDGES (CF4). Core roles run on the deterministic spine instead, so
 * they are excluded here. Pure; gates untouched.
 */
export function workflowCustomAgents(wf: WorkflowConfig): AgentConfig[] {
  return wf.agents.filter(a => !isCoreRole(a.role))
}
