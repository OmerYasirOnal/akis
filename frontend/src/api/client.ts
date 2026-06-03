import type { SessionState, WorkflowConfig, WorkflowConfigInput } from '@akis/shared'
import type { SeqEvent } from '../live/types.js'

export interface ModelOption { id: string; label: string; recommended?: boolean }

/** A preview lifecycle entry (mirrors the backend PreviewEntry). */
export interface PreviewEntry { sessionId: string; status: 'starting' | 'ready' | 'failed' | 'stopped' | 'unsupported'; url?: string; reason?: string }

/** The authenticated user projection (matches the backend PublicUser). */
export interface AuthUser { id: string; name: string; email: string }

/** A build-history row from GET /sessions/mine. */
export interface SessionSummary { id: string; idea: string; status: string; verified: boolean }

/** GET /health projection. `mode:'demo'` means the mock provider and/or mock verification
 *  is active — "verified" output is NOT from real tests; the FE surfaces a warning badge. */
export interface HealthInfo { ok: boolean; persistence: 'postgres' | 'memory'; mode: 'live' | 'demo' }

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

/** Typed error for non-2xx responses (gate 409s carry a `code`; workflow 400s carry the
 *  `errors[]` field-level validation list from validateWorkflowConfig). */
export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string, readonly errors?: string[]) {
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

  /**
   * Fired once whenever an authenticated request comes back 401 (the cookie expired /
   * was revoked). The app wires this to clear the cached user and route to /login, so a
   * stale session never leaves the user stuck. The /auth/me probe is exempt (its 401 is
   * the normal "anonymous on load" signal, not an expiry — see json()).
   */
  onUnauthorized: (() => void) | undefined = undefined

  /** Server health + serving mode (read once on load to surface the demo badge). */
  health(): Promise<HealthInfo> { return this.json<HealthInfo>('/health') }

  startSession(idea: string, workflowId?: string): Promise<SessionState> {
    return this.json<SessionState>('/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idea, ...(workflowId ? { workflowId } : {}) }) })
  }
  getSession(id: string): Promise<SessionState> {
    return this.json<SessionState>(`/sessions/${id}`)
  }
  /** The current user's build history (newest first; auth required). */
  listMySessions(): Promise<SessionSummary[]> { return this.json<SessionSummary[]>('/sessions/mine') }
  /** The retained {seq,event}[] log — fetched on an SSE `reset` to rebuild the live view. */
  async getSessionLog(id: string): Promise<SeqEvent[]> {
    const { events } = await this.json<{ events: SeqEvent[]; head: number }>(`/sessions/${id}/log`)
    return events
  }
  approve(id: string): Promise<SessionState> { return this.post(`/sessions/${id}/approve`) }
  run(id: string): Promise<SessionState> { return this.post(`/sessions/${id}/run`) }
  confirm(id: string): Promise<SessionState> { return this.post(`/sessions/${id}/confirm`) }
  /** Recovery: resolve an awaiting_critic_resolution park. 'proceed' continues the pipeline
   *  (to the spec gate if unapproved, else the REAL verify + push gates); 'abandon' cancels.
   *  This is NOT a structural gate — the server never lets it bypass verify/push. */
  resolveCritic(id: string, decision: 'proceed' | 'abandon'): Promise<SessionState> {
    return this.json<SessionState>(`/sessions/${id}/resolve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision }) })
  }
  /** Recovery: retry a verify_failed run. Re-enters the iterate loop and RE-RUNS REAL
   *  verification (mint still needs a genuine ≥1-test pass — no bypass). */
  retryRun(id: string): Promise<SessionState> { return this.post(`/sessions/${id}/retry`) }
  /** Run control: STOP/CANCEL an in-flight run — a clean TERMINAL abandon. NOT a gate
   *  bypass: the server only sets `cancelled` (terminal); it never verifies/ships. 409 from
   *  an already-terminal run. */
  cancelRun(id: string): Promise<SessionState> { return this.post(`/sessions/${id}/cancel`) }
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

  /**
   * Streaming variant of {@link chatWithAkis}: POST /api/chat/stream and consume the SSE
   * frames, calling `onDelta(text)` per `delta` frame as it arrives (so the UI feels
   * alive). Resolves with the FULL assembled reply from the terminal `done` frame (used
   * to re-run spec detection on the authoritative text). Throws an ApiError on a non-ok
   * status OR an `error` frame, AND on a 401 it routes to login like every other call —
   * so the caller (AkisChat) can fall back to the non-stream await path on any failure.
   */
  async chatWithAkisStream(
    message: string,
    history: { role: 'user' | 'assistant'; content: string }[],
    onDelta: (delta: string) => void,
  ): Promise<{ reply: string }> {
    const res = await this.fetchFn(this.baseUrl + '/api/chat/stream', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ message, history }),
    })
    if (!res.ok) {
      if (res.status === 401) this.onUnauthorized?.()
      const b = await res.json().catch(() => ({})) as { error?: string; code?: string }
      throw new ApiError(res.status, b.error ?? `HTTP ${res.status}`, b.code)
    }
    if (!res.body) throw new ApiError(0, 'streaming response had no body', 'NoBody')

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let reply: string | undefined
    let streamErr: ApiError | undefined
    // Parse one complete SSE frame: read its `event:` + JSON `data:` and dispatch.
    const handleFrame = (frame: string): void => {
      let event = 'message'
      let dataLine = ''
      for (const line of frame.split('\n')) {
        const l = line.trimStart()
        if (l.startsWith('event:')) event = l.slice(6).trim()
        else if (l.startsWith('data:')) dataLine = l.slice(5).trim()
      }
      if (!dataLine) return
      let data: { text?: string; reply?: string; message?: string; code?: string }
      try { data = JSON.parse(dataLine) } catch { return } // ignore malformed frame
      if (event === 'delta' && typeof data.text === 'string') onDelta(data.text)
      else if (event === 'done') reply = typeof data.reply === 'string' ? data.reply : ''
      else if (event === 'error') streamErr = new ApiError(502, data.message ?? 'chat failed', data.code ?? 'ProviderError')
    }
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
        const frame = buf.slice(0, idx)
        buf = buf.slice(idx + (buf[idx] === '\r' ? 4 : 2))
        if (frame.trim()) handleFrame(frame)
      }
    }
    if (buf.trim()) handleFrame(buf) // a final frame with no trailing blank line
    if (streamErr) throw streamErr
    return { reply: reply ?? '' }
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
  /** Fetch a single workflow by id; pass `version` to read a specific prior version
   *  (the version-history probe). A missing id/version surfaces as an ApiError(404). */
  getWorkflow(id: string, version?: number): Promise<WorkflowConfig> {
    const q = version !== undefined ? `?version=${encodeURIComponent(version)}` : ''
    return this.json<WorkflowConfig>(`/api/workflows/${encodeURIComponent(id)}${q}`)
  }
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
      // A 401 on an authenticated route means the session expired/was revoked: notify the
      // app to clear the cached user + route to login. Exempt /auth/me — its 401 is the
      // normal anonymous-on-load signal (AuthContext handles it), not an expiry, so firing
      // here would bounce a guest to /login on every page load.
      // Fire on any authenticated 401 EXCEPT the anon-load probe (GET /auth/me) — a PATCH
      // /auth/me (profile update) on an expired session SHOULD still route to login.
      if (res.status === 401 && !(path === '/auth/me' && (init?.method ?? 'GET') === 'GET')) this.onUnauthorized?.()
      const b = body as { error?: string; code?: string; errors?: unknown }
      const errors = Array.isArray(b.errors) ? b.errors.filter((e): e is string => typeof e === 'string') : undefined
      throw new ApiError(res.status, b.error ?? `HTTP ${res.status}`, b.code, errors)
    }
    return body as T
  }
}
