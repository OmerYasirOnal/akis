import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientMetadata, OAuthClientInformation, OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'

/**
 * SERVER-SIDE OAuth for remote MCP (the "agents really use MCP" core). The MCP SDK's
 * OAuthClientProvider was shaped for a desktop client that owns the browser; AKIS is a multi-user
 * server where the browser belongs to the user and the redirect/callback happen out-of-band. This
 * adapter bridges that: it implements OAuthClientProvider backed by a per-(user,provider) store, and
 * instead of redirecting server-side it CAPTURES the authorization URL so the connect route can 302
 * the user's browser to it.
 *
 * Flow (driven by the SDK `auth()` helper):
 *  1. connect route: `auth(provider, { serverUrl })` → SDK discovers + (if no client) Dynamic-Client-
 *     Registers via saveClientInformation + builds the authorize URL + calls redirectToAuthorization,
 *     which we capture → the route 302s the browser there. PKCE verifier is persisted via saveCodeVerifier.
 *  2. callback route: `auth(provider, { serverUrl, authorizationCode })` → SDK exchanges the code with
 *     the persisted verifier → saveTokens.
 *  3. transport use: StreamableHTTPClientTransport(url, { authProvider }) → SDK attaches the bearer
 *     from tokens() + auto-refreshes (saveTokens) on 401 — no hand-rolled refresh.
 *
 * DCR means NO pre-registered OAuth app for servers that support it (Atlassian). The store holds the
 * registered client info + tokens encrypted (see RemoteMcpAuthStore impl); the PKCE verifier is
 * transient. Secrets never log/argv. The provider is owner-scoped — one instance per (userId, provider).
 */

/** The per-(user,provider) persisted auth material. clientInfo = the DCR-registered client; tokens =
 *  the access+refresh pair; codeVerifier = the transient PKCE verifier for an in-flight connect. */
export interface RemoteMcpAuthRecord {
  clientInfo?: OAuthClientInformationFull
  tokens?: OAuthTokens
  codeVerifier?: string
}

/** A save patch — each field is OPTIONAL but may be EXPLICITLY undefined to CLEAR it (used by
 *  invalidateCredentials). Distinct from Partial<Record> so exactOptionalPropertyTypes allows the
 *  explicit-undefined clear. */
export type RemoteMcpAuthPatch = {
  clientInfo?: OAuthClientInformationFull | undefined
  tokens?: OAuthTokens | undefined
  codeVerifier?: string | undefined
}

/** Narrow store port the provider depends on (sync — our encrypted stores are sync). The real impl
 *  persists clientInfo+tokens encrypted at rest; an in-memory fake backs the unit tests. */
export interface RemoteMcpAuthStore {
  load(userId: string, provider: string): RemoteMcpAuthRecord | undefined
  save(userId: string, provider: string, patch: RemoteMcpAuthPatch): void
  clearVerifier(userId: string, provider: string): void
  /** Remove a connection entirely (the disconnect route). */
  remove(userId: string, provider: string): void
  /** Whether auth material CAN be persisted right now (encryption configured) — a non-throwing
   *  preflight so the connect route never starts an OAuth flow it can't persist. */
  canStore(): boolean
}

export interface StoreBackedOAuthOptions {
  userId: string
  provider: string
  /** The OAuth callback URL registered as a redirect_uri (e.g. ${PUBLIC_BASE_URL}/mcp/<provider>/callback). */
  redirectUrl: string
  /** Space-separated OAuth scopes (e.g. the Atlassian read+write+offline_access set). */
  scope: string
  clientName?: string
  store: RemoteMcpAuthStore
}

export class StoreBackedOAuthProvider implements OAuthClientProvider {
  /** Set by redirectToAuthorization — the connect route reads it after `auth()` returns REDIRECT and
   *  302s the user's browser here. Never redirects server-side. */
  capturedAuthorizationUrl: URL | undefined

  constructor(private opts: StoreBackedOAuthOptions) {}

  get redirectUrl(): string { return this.opts.redirectUrl }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.opts.clientName ?? 'AKIS',
      redirect_uris: [this.opts.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none', // public client — PKCE, no client secret
      scope: this.opts.scope,
    }
  }

  clientInformation(): OAuthClientInformation | undefined {
    return this.load().clientInfo
  }

  // DCR: the SDK calls this after registering a client with the server. Persist it so later
  // sessions reuse the SAME client (no re-registration).
  saveClientInformation(info: OAuthClientInformationFull): void {
    this.opts.store.save(this.opts.userId, this.opts.provider, { clientInfo: info })
  }

  tokens(): OAuthTokens | undefined {
    return this.load().tokens
  }

  // Called after the initial exchange AND after every refresh (rotated refresh token) — persist so
  // the connection stays fresh across sessions without any hand-rolled refresh logic.
  saveTokens(tokens: OAuthTokens): void {
    this.opts.store.save(this.opts.userId, this.opts.provider, { tokens })
  }

  // SERVER bridge: capture the URL instead of redirecting; the connect route 302s the browser.
  redirectToAuthorization(authorizationUrl: URL): void {
    this.capturedAuthorizationUrl = authorizationUrl
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.opts.store.save(this.opts.userId, this.opts.provider, { codeVerifier })
  }

  codeVerifier(): string {
    const v = this.load().codeVerifier
    if (!v) throw new Error('remote-mcp oauth: no PKCE code_verifier for this connect (expired or out-of-order callback)')
    return v
  }

  /** After a successful token exchange the transient verifier is no longer needed — drop it. */
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'verifier' || scope === 'all') this.opts.store.clearVerifier(this.opts.userId, this.opts.provider)
    if (scope === 'tokens' || scope === 'all') this.opts.store.save(this.opts.userId, this.opts.provider, { tokens: undefined })
    if (scope === 'client' || scope === 'all') this.opts.store.save(this.opts.userId, this.opts.provider, { clientInfo: undefined })
  }

  private load(): RemoteMcpAuthRecord {
    return this.opts.store.load(this.opts.userId, this.opts.provider) ?? {}
  }
}

/** A simple in-memory RemoteMcpAuthStore (tests + the host-injection default). The real impl encrypts
 *  clientInfo+tokens at rest under a per-(user,provider) AAD (slice 5 — generalize AtlassianConnectionStore). */
export class MemoryRemoteMcpAuthStore implements RemoteMcpAuthStore {
  private rows = new Map<string, RemoteMcpAuthRecord>()
  private key(u: string, p: string): string { return `${p}:${u}` }
  load(userId: string, provider: string): RemoteMcpAuthRecord | undefined { return this.rows.get(this.key(userId, provider)) }
  save(userId: string, provider: string, patch: RemoteMcpAuthPatch): void {
    const k = this.key(userId, provider)
    const cur = this.rows.get(k) ?? {}
    // An explicit `undefined` in the patch CLEARS the field (used by invalidateCredentials); a key
    // ABSENT from the patch leaves it untouched.
    const next: RemoteMcpAuthRecord = { ...cur }
    if ('clientInfo' in patch) { if (patch.clientInfo === undefined) delete next.clientInfo; else next.clientInfo = patch.clientInfo }
    if ('tokens' in patch) { if (patch.tokens === undefined) delete next.tokens; else next.tokens = patch.tokens }
    if ('codeVerifier' in patch) { if (patch.codeVerifier === undefined) delete next.codeVerifier; else next.codeVerifier = patch.codeVerifier }
    this.rows.set(k, next)
  }
  clearVerifier(userId: string, provider: string): void {
    const k = this.key(userId, provider)
    const cur = this.rows.get(k)
    if (cur) { delete cur.codeVerifier; this.rows.set(k, cur) }
  }
  remove(userId: string, provider: string): void { this.rows.delete(this.key(userId, provider)) }
  canStore(): boolean { return true } // in-memory needs no encryption
}
