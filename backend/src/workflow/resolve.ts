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
      out[a.role] = { provider: a.model.providerId as ProviderId, ...(a.model.modelId !== undefined ? { model: a.model.modelId } : {}) }
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
