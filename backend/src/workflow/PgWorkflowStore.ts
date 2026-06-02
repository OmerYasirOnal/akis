import { randomUUID } from 'node:crypto'
import type { WorkflowConfig, WorkflowConfigInput, AgentConfig, GatePolicy } from '@akis/shared'
import type { WorkflowStorePort } from './WorkflowStore.js'
import type { SqlClient } from '../store/pg.js'

/**
 * Postgres-backed workflow preset store (the durable seam behind WorkflowStorePort,
 * selected when DATABASE_URL is set). Pure SQL over an injected SqlClient —
 * unit-testable with a fake client and drop-in for a real `pg` Pool. Behavioural parity
 * with the in-memory WorkflowStore.
 *
 * VERSIONED: a save appends a NEW row keyed by (id, version) — editing never mutates a
 * prior version, so an in-flight run that captured version N is unaffected (F2-AC10).
 * The next version is `MAX(version) + 1` for the id (1 for a brand-new id).
 * `agents`/`gate_policy` are jsonb; `rag`/`rerank` are nullable booleans — a tri-state
 * (unset vs explicit false vs true), so an explicit `false` is persisted as `false`,
 * never coerced to null.
 */
export class PgWorkflowStore implements WorkflowStorePort {
  constructor(private db: SqlClient, private genId: () => string = randomUUID) {}

  async save(input: WorkflowConfigInput): Promise<WorkflowConfig> {
    const id = input.id ?? this.genId()
    // Next version = max for this id + 1 (1 for a new id). A row per save → no mutation
    // of a prior version. (Concurrent saves to the same id are out of scope for the MVP,
    // consistent with the in-memory store; the (id, version) PK would reject a true dup.)
    const { rows } = await this.db.query('SELECT MAX(version) AS max FROM workflows WHERE id = $1', [id])
    const prior = rows[0]?.max
    const version = prior == null ? 1 : Number(prior) + 1
    const { rows: inserted } = await this.db.query(
      `INSERT INTO workflows (id, version, name, agents, gate_policy, iterate_budget, rag, rerank)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        id, version, input.name,
        // agents/gate_policy → jsonb; booleans must keep an explicit `false` (use ?? null
        // ONLY for the genuinely-absent case, never for a present false).
        input.agents,
        input.gatePolicy ?? null,
        input.iterateBudget ?? null,
        input.rag ?? null,
        input.rerank ?? null,
      ],
    )
    return toWorkflow(inserted[0]!)
  }

  async get(id: string, version?: number): Promise<WorkflowConfig | undefined> {
    const { rows } = version === undefined
      ? await this.db.query('SELECT * FROM workflows WHERE id = $1 ORDER BY version DESC LIMIT 1', [id])
      : await this.db.query('SELECT * FROM workflows WHERE id = $1 AND version = $2', [id, version])
    return rows[0] ? toWorkflow(rows[0]) : undefined
  }

  async list(): Promise<WorkflowConfig[]> {
    // Latest row per id: DISTINCT ON (id) with id ASC, version DESC keeps the highest
    // version of each workflow (Postgres picks the first row per DISTINCT ON group).
    const { rows } = await this.db.query(
      'SELECT DISTINCT ON (id) * FROM workflows ORDER BY id, version DESC',
    )
    return rows.map(toWorkflow)
  }
}

/** The raw `workflows` row shape `pg` returns (snake_case; jsonb columns already parsed
 *  by `pg` into JS values). */
interface WorkflowRow {
  id: unknown; version: unknown; name: unknown; agents: unknown
  gate_policy: unknown; iterate_budget: unknown; rag: unknown; rerank: unknown
}

/**
 * Map a DB row back to WorkflowConfig. Optional fields are spread conditionally (never
 * set to `undefined`) to satisfy exactOptionalPropertyTypes — and a persisted `false`
 * for rag/rerank is preserved (the guard is `!= null`, NOT truthiness), so the explicit
 * tri-state survives the round-trip.
 */
function toWorkflow(raw: Record<string, unknown>): WorkflowConfig {
  const r = raw as unknown as WorkflowRow
  return {
    id: String(r.id),
    version: Number(r.version),
    name: String(r.name),
    agents: r.agents as AgentConfig[],
    ...(r.gate_policy != null ? { gatePolicy: r.gate_policy as GatePolicy } : {}),
    ...(r.iterate_budget != null ? { iterateBudget: Number(r.iterate_budget) } : {}),
    ...(r.rag != null ? { rag: Boolean(r.rag) } : {}),
    ...(r.rerank != null ? { rerank: Boolean(r.rerank) } : {}),
  }
}
