import type { SessionState, WorkflowConfig, WorkflowConfigInput } from '@akis/shared'
import type { SeqEvent } from '../live/types.js'

export interface ModelOption { id: string; label: string; recommended?: boolean }
export interface ProviderInfo {
  id: string
  label: string
  available: boolean
  defaultModel: string
  models: ModelOption[]
  last4?: string
  updatedAt?: string
}

/** Typed error for non-2xx responses (gate 409s carry a `code`). */
export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message)
    this.name = 'ApiError'
  }
  static is(e: unknown): e is ApiError {
    return e instanceof ApiError
  }
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

/** Thin typed REST client for the orchestrator routes (sub-project 2). The FE holds
 *  no gate authority — approve/confirm just POST to the gated routes, which enforce
 *  the gates server-side. `fetchFn` is injectable for tests. */
export class ApiClient {
  constructor(private baseUrl = '', private fetchFn: FetchFn = (i, n) => fetch(i, n)) {}

  startSession(idea: string, workflowId?: string): Promise<SessionState> {
    return this.json<SessionState>('/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idea, ...(workflowId ? { workflowId } : {}) }) })
  }
  getSession(id: string): Promise<SessionState> {
    return this.json<SessionState>(`/sessions/${id}`)
  }
  /** The retained {seq,event}[] log — fetched on an SSE `reset` to rebuild the live view. */
  async getSessionLog(id: string): Promise<SeqEvent[]> {
    const { events } = await this.json<{ events: SeqEvent[]; head: number }>(`/sessions/${id}/log`)
    return events
  }
  approve(id: string): Promise<SessionState> { return this.post(`/sessions/${id}/approve`) }
  run(id: string): Promise<SessionState> { return this.post(`/sessions/${id}/run`) }
  confirm(id: string): Promise<SessionState> { return this.post(`/sessions/${id}/confirm`) }
  listProviders(): Promise<ProviderInfo[]> { return this.json<ProviderInfo[]>('/api/providers') }
  listWorkflows(): Promise<WorkflowConfig[]> { return this.json<WorkflowConfig[]>('/api/workflows') }
  saveWorkflow(input: WorkflowConfigInput): Promise<WorkflowConfig> {
    return this.json<WorkflowConfig>('/api/workflows', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
  }

  private post(path: string): Promise<SessionState> {
    return this.json<SessionState>(path, { method: 'POST' })
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchFn(this.baseUrl + path, init)
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      const b = body as { error?: string; code?: string }
      throw new ApiError(res.status, b.error ?? `HTTP ${res.status}`, b.code)
    }
    return body as T
  }
}
