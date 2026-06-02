import { randomUUID } from 'node:crypto'
import type { WorkflowConfig, WorkflowConfigInput } from '@akis/shared'

/**
 * Versioned workflow store. Saving an EXISTING id appends a NEW version (F2-AC10:
 * editing never mutates a prior version, so an in-flight run that captured version N
 * is unaffected). In-memory for the MVP (a DB impl drops in behind the same shape).
 */
export class WorkflowStore {
  private versions = new Map<string, WorkflowConfig[]>()

  save(input: WorkflowConfigInput): WorkflowConfig {
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
  get(id: string, version?: number): WorkflowConfig | undefined {
    const all = this.versions.get(id)
    if (!all || all.length === 0) return undefined
    if (version === undefined) return all[all.length - 1]
    return all.find(w => w.version === version)
  }

  /** The latest version of every workflow. */
  list(): WorkflowConfig[] {
    return [...this.versions.values()].map(vs => vs[vs.length - 1]!).filter(Boolean)
  }
}
