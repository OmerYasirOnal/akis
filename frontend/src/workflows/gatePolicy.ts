/**
 * gatePolicy.ts — a PURE, framework-free mirror of the backend's
 * `workflow/validate.ts` (F2-AC3/AC4/AC5). This is the single client-side source for
 * the tighten-only guards: the builder UI consults it BEFORE POSTing, so it can never
 * even attempt to loosen a gate. The backend `validateWorkflowConfig` remains the
 * source of truth and the final 400; this module exists only to keep the UI honest and
 * give immediate feedback. No React, no `any`.
 */
import {
  isGateTool,
  GATE_TOOL_OWNER,
  MAX_ITERATE_BUDGET,
  type GateTool,
  type Role,
  type WorkflowConfigInput,
} from '@akis/shared'

/** The provider catalog the draft validates against — the GET /api/providers shape,
 *  narrowed to the only fields the pure guards need. Injected (never hard-coded) so the
 *  module stays framework-free and unit-testable. */
export interface DraftCatalogProvider {
  id: string
  models: readonly { id: string }[]
}

export type DraftValidation = { ok: true } | { ok: false; errors: string[] }

/**
 * The FOUR structural gates (F2 docs.gates) — always-on, locked, never removable from
 * the UI. `critic_resolution` is the only one whose *required* status the user may add
 * to (via GatePolicy.requireCriticResolution); it is still enforced regardless.
 */
export const STRUCTURAL_GATES = ['spec_approval', 'real_test_verification', 'push_confirm', 'critic_resolution'] as const
export type StructuralGate = typeof STRUCTURAL_GATES[number]

/**
 * A gate as rendered/enforced for a seeded run. `enforced` is ALWAYS true — the preset
 * can never bypass a structural gate. `policyToggle` marks the one gate a tighten-only
 * GatePolicy lever can require (critic resolution); `required` reflects whether that
 * lever is currently ON (the other 3 gates are unconditionally required).
 */
export interface EnforcedGate {
  id: StructuralGate
  enforced: true
  policyToggle: boolean
  required: boolean
}

/**
 * Resolve a GatePolicy into the enforced gate list a run will honor. The policy is
 * ADDITIVE (tighten-only): there is no field that can DISABLE a gate, so the result is
 * always all 4 structural gates, each enforced. `requireCriticResolution` only flips
 * whether critic resolution is a *required* (vs advisory) gate — never whether it runs.
 */
export function applyGatePolicy(policy: { requireCriticResolution?: boolean } | undefined): EnforcedGate[] {
  return STRUCTURAL_GATES.map(id => {
    const policyToggle = id === 'critic_resolution'
    return {
      id,
      enforced: true as const,
      policyToggle,
      // The 3 non-toggleable gates are always required; critic resolution is required
      // only when the tighten-only lever is ON (it still always runs/enforces).
      required: policyToggle ? policy?.requireCriticResolution === true : true,
    }
  })
}

/** Whether `tool` may be granted to `role`. A gate tool is allowed ONLY for its
 *  structural GATE_TOOL_OWNER; any non-gate tool is allowed for any role. Mirrors the
 *  ownership check in validate.ts. */
export function isGateAllowedForRole(role: Role | string, tool: string): boolean {
  if (!isGateTool(tool)) return true
  return role === GATE_TOOL_OWNER[tool as GateTool]
}

/** Clamp an iterate budget into the tighten-only range 1..MAX_ITERATE_BUDGET (3).
 *  Non-integers floor; out-of-range and NaN clamp to the nearest bound. */
export function clampIterateBudget(n: number): number {
  if (!Number.isFinite(n)) return 1
  const floored = Math.floor(n)
  if (floored < 1) return 1
  if (floored > MAX_ITERATE_BUDGET) return MAX_ITERATE_BUDGET
  return floored
}

/**
 * Pure mirror of backend `validateWorkflowConfig` (F2-AC4). Rejects the SAME shapes so
 * the UI never POSTs a draft the backend will 400 — but the backend stays the source of
 * truth (its 400 is surfaced, never swallowed). The provider catalog is injected.
 */
export function validateWorkflowDraft(cfg: WorkflowConfigInput, catalog: readonly DraftCatalogProvider[]): DraftValidation {
  const errors: string[] = []
  if (!cfg.name?.trim()) errors.push('name is required')
  if (!Array.isArray(cfg.agents) || cfg.agents.length === 0) errors.push('at least one agent is required')

  for (const a of cfg.agents ?? []) {
    const where = `agent '${a.role}'`
    // A gate capability may only be held by its structural owner (producer ≠ verifier).
    for (const tool of a.tools ?? []) {
      if (isGateTool(tool)) {
        const owner = GATE_TOOL_OWNER[tool as GateTool]
        if (a.role !== owner) errors.push(`${where}: cannot hold gate capability '${tool}' (only '${owner}' may)`)
      }
    }

    // Per-agent model must exist in the (injected) catalog.
    if (a.model?.providerId !== undefined) {
      const pid = a.model.providerId
      const provider = catalog.find(p => p.id === pid)
      if (!provider) {
        errors.push(`${where}: unknown providerId '${pid}'`)
      } else if (a.model.modelId !== undefined) {
        const models = provider.models.map(m => m.id)
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
