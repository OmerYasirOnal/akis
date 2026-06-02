import { randomUUID } from 'node:crypto'
import type { WorkflowConfig, WorkflowConfigInput } from '@akis/shared'

/**
 * The workflow preset store seam. ASYNC so the in-memory store and the durable
 * {@link PgWorkflowStore} are interchangeable (selected by DATABASE_URL): save/get/list
 * all resolve Promises. Workflows are VERSIONED — saving an EXISTING id appends a NEW
 * version (F2-AC10: editing never mutates a prior version, so an in-flight run that
 * captured version N is unaffected).
 */
export interface WorkflowStorePort {
  /** Save (create or, for an existing id, append a new version). Resolves the saved config. */
  save(input: WorkflowConfigInput): Promise<WorkflowConfig>
  /** Latest version (or a specific one) of a workflow; undefined when unknown. */
  get(id: string, version?: number): Promise<WorkflowConfig | undefined>
  /** The latest version of every workflow. */
  list(): Promise<WorkflowConfig[]>
}

/**
 * In-memory {@link WorkflowStorePort} (the default, current behavior). The methods are
 * async to match the port; a real DB impl (PgWorkflowStore) drops in behind the same
 * shape. Versioned exactly as before.
 */
export class WorkflowStore implements WorkflowStorePort {
  private versions = new Map<string, WorkflowConfig[]>()

  async save(input: WorkflowConfigInput): Promise<WorkflowConfig> {
    const id = input.id ?? randomUUID()
    const prior = this.versions.get(id) ?? []
    const version = prior.length === 0 ? 1 : prior[prior.length - 1]!.version + 1
    const saved: WorkflowConfig = {
      id, version, name: input.name, agents: input.agents,
      ...(input.gatePolicy !== undefined ? { gatePolicy: input.gatePolicy } : {}),
      ...(input.iterateBudget !== undefined ? { iterateBudget: input.iterateBudget } : {}),
      ...(input.rag !== undefined ? { rag: input.rag } : {}),
      ...(input.rerank !== undefined ? { rerank: input.rerank } : {}),
    }
    this.versions.set(id, [...prior, saved])
    return saved
  }

  /** Latest version (or a specific one) of a workflow. */
  async get(id: string, version?: number): Promise<WorkflowConfig | undefined> {
    const all = this.versions.get(id)
    if (!all || all.length === 0) return undefined
    if (version === undefined) return all[all.length - 1]
    return all.find(w => w.version === version)
  }

  /** The latest version of every workflow. */
  async list(): Promise<WorkflowConfig[]> {
    return [...this.versions.values()].map(vs => vs[vs.length - 1]!).filter(Boolean)
  }
}
