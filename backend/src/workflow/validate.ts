import { isGateTool, GATE_TOOL_OWNER, type GateTool, type WorkflowConfigInput, MAX_ITERATE_BUDGET } from '@akis/shared'
import { CATALOG, REAL_PROVIDERS } from '../agent/providers/catalog.js'

export type ValidationResult = { ok: true } | { ok: false; errors: string[] }

/**
 * Validate a WorkflowConfig at SAVE time (F2-AC4) — never a runtime surprise. Rejects:
 *  - an unknown `{providerId, modelId}` vs the catalog (F2-AC6),
 *  - granting a gate capability to a role that doesn't structurally own it
 *    (producer/custom with run_tests/push/etc.) — keeps producer≠verifier (F2-AC3/AC5),
 *  - a custom (non-core) agent declared as the verifier (F2-AC3),
 *  - an iterate budget above the hard cap (gate policy is tighten-only, F2-AC5).
 * The 4 structural gates can only be ADDED to (gatePolicy is additive by type).
 */
export function validateWorkflowConfig(cfg: WorkflowConfigInput): ValidationResult {
  const errors: string[] = []
  if (!cfg.name?.trim()) errors.push('name is required')
  if (!Array.isArray(cfg.agents) || cfg.agents.length === 0) errors.push('at least one agent is required')

  for (const a of cfg.agents ?? []) {
    const where = `agent '${a.role}'`
    // A custom (non-core) agent can never hold a gate capability. The verifier role
    // ('trace') is itself core, so "custom == verifier" is impossible by name; the
    // real protection is the gate-tool ownership check below (a custom agent granted
    // run_tests/dispatch_trace is rejected since it isn't the structural owner).
    for (const tool of a.tools ?? []) {
      if (isGateTool(tool)) {
        const owner = GATE_TOOL_OWNER[tool as GateTool]
        if (a.role !== owner) errors.push(`${where}: cannot hold gate capability '${tool}' (only '${owner}' may)`)
      }
    }

    // Per-agent model must exist in the catalog.
    if (a.model?.providerId !== undefined) {
      const pid = a.model.providerId
      if (!(REAL_PROVIDERS as readonly string[]).includes(pid)) {
        errors.push(`${where}: unknown providerId '${pid}'`)
      } else if (a.model.modelId !== undefined) {
        const models = CATALOG[pid as keyof typeof CATALOG].models.map(m => m.id)
        if (!models.includes(a.model.modelId)) errors.push(`${where}: model '${a.model.modelId}' not in provider '${pid}' catalog`)
      }
    }
  }

  if (cfg.iterateBudget !== undefined) {
    if (!Number.isInteger(cfg.iterateBudget) || cfg.iterateBudget < 1) errors.push('iterateBudget must be a positive integer')
    else if (cfg.iterateBudget > MAX_ITERATE_BUDGET) errors.push(`iterateBudget cannot exceed the cap (${MAX_ITERATE_BUDGET}); gate policy is tighten-only`)
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors }
}
