import type { SessionState, WorkflowConfig, WorkflowConfigInput } from '@akis/shared'
import type { SeqEvent } from '../live/types.js'

export interface ModelOption { id: string; label: string; recommended?: boolean }

/** A preview lifecycle entry (mirrors the backend PreviewEntry). */
export interface PreviewEntry { sessionId: string; status: 'starting' | 'ready' | 'failed' | 'stopped' | 'unsupported'; url?: string; reason?: string }

/** The authenticated user projection (matches the backend PublicUser). */
export interface AuthUser { id: string; name: string; email: string }

/** Per-agent activity counts for the analytics dashboard. */
export interface AgentStat { agent: string; runs: number; ok: number }
/** Aggregate run analytics surfaced on the Agents tab. */
export interface Analytics {
  sessions: number
  done: number
  failed: number
  running: number
  verifiedRuns: number
  testsRun: number
  passRate: number          // 0..1 across verify events
  avgSpecScore?: number
  agents: AgentStat[]
  provider?: string
}
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
  /** Start (or restart) the local in-browser preview of the produced app. Emits
   *  preview_status on the SSE stream; the iframe embeds /preview/:id/ when ready. */
  startPreview(id: string): Promise<PreviewEntry> {
    return this.json<PreviewEntry>(`/sessions/${id}/preview`, { method: 'POST' })
  }
  /** Aggregate run analytics for the Agents dashboard. */
  getAnalytics(): Promise<Analytics> { return this.json<Analytics>('/api/analytics') }

  // ── Auth (JWT-in-cookie; the cookie rides on credentials:'include') ──
  signup(input: { name: string; email: string; password: string }): Promise<{ user: AuthUser }> {
    return this.json('/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
  }
  login(email: string, password: string): Promise<{ user: AuthUser }> {
    return this.json('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })
  }
  me(): Promise<{ user: AuthUser }> { return this.json('/auth/me') }
  logout(): Promise<{ ok: boolean }> { return this.json('/auth/logout', { method: 'POST' }) }
  updateProfile(name: string): Promise<{ user: AuthUser }> {
    return this.json('/auth/me', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) })
  }
  changePassword(currentPassword: string, newPassword: string): Promise<{ ok: boolean }> {
    return this.json('/auth/change-password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ currentPassword, newPassword }) })
  }
  forgotPassword(email: string): Promise<{ message: string; resetToken?: string; resetUrl?: string }> {
    return this.json('/auth/forgot-password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) })
  }
  resetPassword(token: string, password: string): Promise<{ user: AuthUser }> {
    return this.json('/auth/reset-password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, password }) })
  }
  /** Which OAuth providers are configured server-side (drives which buttons to show). */
  getOAuthProviders(): Promise<{ providers: string[] }> { return this.json('/oauth/providers') }
  /** Full-page redirect target to begin an OAuth flow. */
  oauthAuthorizeUrl(provider: string): string { return `${this.baseUrl}/oauth/${provider}/authorize` }

  /** Free-form conversation WITH AKIS (the orchestrator persona) — distinct from a build. */
  chatWithAkis(message: string, history: { role: 'user' | 'assistant'; content: string }[] = []): Promise<{ reply: string }> {
    return this.json('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message, history }) })
  }
  listProviders(): Promise<ProviderInfo[]> { return this.json<ProviderInfo[]>('/api/providers') }
  /** Save a provider API key (stored encrypted server-side; response never echoes it). */
  setProviderKey(provider: string, apiKey: string): Promise<{ provider: string; last4: string }> {
    return this.json(`/api/providers/${provider}/key`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKey }) })
  }
  removeProviderKey(provider: string): Promise<{ provider: string; removed: boolean }> {
    return this.json(`/api/providers/${provider}/key`, { method: 'DELETE' })
  }
  listWorkflows(): Promise<WorkflowConfig[]> { return this.json<WorkflowConfig[]>('/api/workflows') }
  saveWorkflow(input: WorkflowConfigInput): Promise<WorkflowConfig> {
    return this.json<WorkflowConfig>('/api/workflows', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
  }

  private post(path: string): Promise<SessionState> {
    return this.json<SessionState>(path, { method: 'POST' })
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    // Always send the session cookie (same-origin in prod; CORS-credentialed in dev).
    const res = await this.fetchFn(this.baseUrl + path, { credentials: 'include', ...init })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      const b = body as { error?: string; code?: string }
      throw new ApiError(res.status, b.error ?? `HTTP ${res.status}`, b.code)
    }
    return body as T
  }
}
