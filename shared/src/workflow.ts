import type { Role } from './roles.js'

/** The pipeline EDGES where AKIS may consult a custom (advisory) agent. Both edges are
 *  ADVISORY only — never on the verified spine between the 4 structural gates. This is the
 *  single canonical list both the workflow validator and the builder UI read; a custom
 *  agent without a declared phase is dispatched at BOTH edges (default), one WITH a phase
 *  only at that edge (a tighten-only narrowing — it can never grant gate authority). */
export const ADVISORY_PHASES = ['pre_scribe', 'post_code_review'] as const
export type AdvisoryPhase = typeof ADVISORY_PHASES[number]
export function isAdvisoryPhase(p: string): p is AdvisoryPhase {
  return (ADVISORY_PHASES as readonly string[]).includes(p)
}

/** Per-agent configuration inside a workflow preset. `role` is a core Role or a
 *  custom (non-core) role name. Custom agents may hold read/compose tools but never
 *  a gate capability (enforced by the validator). */
export interface AgentConfig {
  role: Role | string
  model?: { providerId: string; modelId?: string }
  tools?: string[]
  skills?: string[]
  /** Persona / instructions for a custom advisory agent (LlmAdvisoryAgent's `persona`).
   *  Ignored for core roles, which run on the deterministic spine. */
  basePromptVariant?: string
  /** ADVISORY ONLY: the pipeline edge a CUSTOM (non-core) agent is dispatched at. Omitted
   *  ⇒ dispatched at every edge. Carries NO gate authority — it only narrows *when* an
   *  advisory note is produced. Ignored for core roles. */
  phase?: AdvisoryPhase
}

/** Gate policy is TIGHTEN-ONLY (F2-AC5): it may ADD required gates, never disable
 *  or loosen the 4 structural gates. */
export interface GatePolicy {
  requireCriticResolution?: boolean
}

/**
 * A typed, versioned workflow preset (F2-AC1). It seeds/bounds an orchestrator run —
 * enabled agents, per-agent model, skills, gate policy, iterate budget, RAG — but
 * cannot define new control flow or loosen a gate. Editing a saved workflow creates
 * a NEW version (F2-AC10); an in-flight run keeps the version it started with.
 */
export interface WorkflowConfig {
  id: string
  version: number
  name: string
  agents: AgentConfig[]
  gatePolicy?: GatePolicy
  iterateBudget?: number
  rag?: boolean
  /** Second-stage rerank toggle (issue #7 AC3): a sibling of `rag`, a skippable
   *  QUALITY knob — never a gate. When set it overrides the stack default for the
   *  run; when omitted the stack default (AKIS_RERANK / on) applies. It can only
   *  re-order already-retrieved chunks, so it can never loosen a structural gate. */
  rerank?: boolean
}

/** Input to save/create a workflow (id/version are assigned by the store). */
export type WorkflowConfigInput = Omit<WorkflowConfig, 'id' | 'version'> & { id?: string }

/** Hard ceiling on the iterate budget — the preset may LOWER it (tighten) but never
 *  raise it above this cap (which is the orchestrator's MAX_ITERATE). */
export const MAX_ITERATE_BUDGET = 3
