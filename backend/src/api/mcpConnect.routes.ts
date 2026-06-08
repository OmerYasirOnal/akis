import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { StoreBackedOAuthProvider, type RemoteMcpAuthStore } from '../agent/mcp/StoreBackedOAuthProvider.js'
import { HttpMcpTransport } from '../agent/mcp/HttpMcpTransport.js'
import { baseUrl } from './oauth.routes.js'
import { signConnectState, verifyConnectState, oauthCreds } from '../auth/oauth.js'

/**
 * Per-user REMOTE MCP connection (the "agents really use MCP" UX). A signed-in user connects their
 * own Atlassian / GitHub account via a browser OAuth 2.1 + PKCE flow that the MCP SDK drives — no PAT
 * to paste, and (Atlassian) no OAuth app to register thanks to Dynamic Client Registration. The
 * resulting tokens are stored encrypted per (user, provider) and auto-refreshed by the SDK.
 *
 * SECURITY: requireAuth on every route (never creates a session/account); the connect preflight
 * fails closed when encryption isn't configured; tokens never appear in a URL/log/response (the
 * callback redirects with only ?mcp=connected|error|denied|unavailable). WRITES via these servers
 * still flow through the external-write gate (agent proposes → human confirms) — never autonomous.
 */

/** Per-provider remote-MCP config (vendor docs, 2026). Atlassian Rovo Remote MCP uses the new
 *  /v1/mcp/authv2 endpoint (legacy /v1/sse retires 2026-06-30); GitHub Remote MCP is GA. Scopes
 *  include the WRITE scopes to create Jira issues / Confluence pages — gated by the external-write
 *  gate, so the scope grants the CAPABILITY but the agent can still only PROPOSE. */
export interface RemoteMcpProviderConfig { serverUrl: string; kind: 'sse' | 'streamable-http'; scope: string }
export const REMOTE_MCP_PROVIDERS: Record<string, RemoteMcpProviderConfig> = {
  atlassian: {
    serverUrl: 'https://mcp.atlassian.com/v1/mcp/authv2',
    kind: 'streamable-http',
    // JIRA-ONLY (owner decision 2026-06-08). The Confluence scopes (read:confluence-content.all,
    // write:confluence-content, read:confluence-space.summary) were REJECTED at Atlassian consent
    // ("app requested scopes that have not been added to the app") because the connected Atlassian
    // site/workspace doesn't grant them — and Atlassian fails the WHOLE authorization, so a single
    // ungranted scope blocks Jira too. Request only Jira; re-add the Confluence scopes when the
    // owner's Atlassian site enables Confluence (+ Rovo MCP) with those permissions.
    scope: 'offline_access read:me read:jira-work write:jira-work',
  },
  github: {
    serverUrl: 'https://api.githubcopilot.com/mcp/',
    kind: 'streamable-http',
    // github.com/login/oauth has NO Dynamic Client Registration, so AKIS connects this server with a
    // STATIC client = its own GitHub OAuth App (see makeProvider / mcpTransportFor). We therefore
    // control the requested scope. This is read-grounding ("read repo context"): GitHub OAuth Apps
    // have no read-only repo scope, so 'repo' is the practical grant (matches the existing
    // GitHub-delivery connect); read:org/read:user round out org+user context. Any WRITE tool the
    // server exposes still flows through the external-write gate, never autonomously.
    scope: 'repo read:org read:user',
  },
}

/**
 * STATIC OAuth client for a remote-MCP provider whose authorization server does NOT support Dynamic
 * Client Registration. Today that is ONLY github: github.com/login/oauth has no registration_endpoint,
 * so the SDK's DCR step would fail; instead we hand the SDK AKIS's own GitHub OAuth App
 * (GITHUB_OAUTH_CLIENT_ID/SECRET) — the SAME app the GitHub-delivery connect uses, whose base-'/'
 * callback already covers ${base}/mcp/github/callback. Returns a SPREADABLE object: `{ staticClient }`
 * when creds are present, or `{}` so the caller can `...` it and OMIT the key entirely under
 * exactOptionalPropertyTypes (a present-but-undefined staticClient would type-error). Absent creds ⇒
 * no static client ⇒ the github connect degrades honestly (DCR is attempted and fails with an
 * 'error' redirect), exactly like a missing OAuth app. Atlassian (and any other provider) is NEVER
 * given a static client → it keeps DCR. */
function staticClientFor(provider: string, env: NodeJS.ProcessEnv): { staticClient?: { clientId: string; clientSecret: string } } {
  if (provider !== 'github') return {}
  const creds = oauthCreds('github', env)
  return creds ? { staticClient: creds } : {}
}

/** The SDK `auth()` driver (injectable for tests). Returns the AuthResult string ('REDIRECT' on the
 *  connect step once the authorize URL is captured; 'AUTHORIZED' on the callback once tokens land). */
export type RemoteMcpAuthFn = (provider: OAuthClientProvider, opts: { serverUrl: string; authorizationCode?: string; scope?: string }) => Promise<string>

const defaultAuth: RemoteMcpAuthFn = async (provider, opts) => {
  const { auth } = await import('@modelcontextprotocol/sdk/client/auth.js')
  return (await auth(provider, opts)) as unknown as string
}

export interface McpConnectDeps {
  store: RemoteMcpAuthStore
  env: NodeJS.ProcessEnv
  /** HMAC secret for the signed OAuth `state` (CSRF + flow-integrity) — the SAME server auth secret
   *  the GitHub-connect flow uses. Binds the callback to a flow THIS user started for THIS provider. */
  secret: string
  /** Resolve the signed-in user id (revocation-aware) — the SAME closure the rest of the server uses. */
  userIdOf: (req: FastifyRequest) => Promise<string | undefined>
  /** Injectable SDK auth() (tests); default = the real SDK auth via dynamic import. */
  auth?: RemoteMcpAuthFn
  /** Injectable provider registry (tests); default = REMOTE_MCP_PROVIDERS. */
  providers?: Record<string, RemoteMcpProviderConfig>
}

export function registerMcpConnectRoutes(app: FastifyInstance, deps: McpConnectDeps): void {
  const authFn = deps.auth ?? defaultAuth
  const providers = deps.providers ?? REMOTE_MCP_PROVIDERS
  const toSettings = (reply: FastifyReply, base: string, status: string): FastifyReply => reply.redirect(`${base}/settings?mcp=${status}`)
  const makeProvider = (req: FastifyRequest, userId: string, name: string, cfg: RemoteMcpProviderConfig): StoreBackedOAuthProvider =>
    new StoreBackedOAuthProvider({
      userId, provider: name, redirectUrl: `${baseUrl(req, deps.env)}/mcp/${name}/callback`,
      scope: cfg.scope, store: deps.store, clientName: 'AKIS',
      // GitHub: no DCR → connect with AKIS's static GitHub OAuth App. Omit when creds are absent so
      // the SDK falls back to DCR (which github lacks → an honest 'error', never a crash). Atlassian
      // never gets a staticClient → keeps DCR.
      ...staticClientFor(name, deps.env),
    })

  // Begin the connect flow: authenticated + a known provider + encryption configured.
  app.get<{ Params: { provider: string } }>('/mcp/:provider/connect', async (req, reply) => {
    const base = baseUrl(req, deps.env)
    const userId = await deps.userIdOf(req)
    if (!userId) return reply.code(401).send({ error: 'unauthorized', code: 'Unauthorized' })
    const cfg = providers[req.params.provider]
    if (!cfg) return toSettings(reply, base, 'unknown')
    // FAIL-CLOSED: never start an OAuth flow we can't persist (encryption off).
    if (!deps.store.canStore()) return toSettings(reply, base, 'unavailable')
    const provider = makeProvider(req, userId, req.params.provider, cfg)
    try {
      const result = await authFn(provider, { serverUrl: cfg.serverUrl, scope: cfg.scope })
      // The SDK (after DCR + PKCE) calls provider.redirectToAuthorization → we captured the URL.
      if (result === 'REDIRECT' && provider.capturedAuthorizationUrl) {
        // Bind a signed `state` to THIS user + provider (short-TTL, HMAC) so the callback can prove
        // it belongs to a flow this user started (CSRF + flow-integrity). The SDK drives PKCE
        // independently via the stored code_verifier, so overriding `state` here is safe.
        const authUrl = new URL(provider.capturedAuthorizationUrl.toString())
        authUrl.searchParams.set('state', signConnectState(userId, req.params.provider, deps.secret))
        return reply.redirect(authUrl.toString())
      }
      if (result === 'AUTHORIZED') return toSettings(reply, base, 'connected') // already authorized (cached tokens)
      return toSettings(reply, base, 'error')
    } catch {
      return toSettings(reply, base, 'error') // token-free — never echo the underlying error
    }
  })

  // OAuth redirect target: exchange the code (PKCE) → saveTokens (in the provider).
  app.get<{ Params: { provider: string }; Querystring: { code?: string; state?: string; error?: string } }>('/mcp/:provider/callback', async (req, reply) => {
    const base = baseUrl(req, deps.env)
    const cfg = providers[req.params.provider]
    if (!cfg) return toSettings(reply, base, 'unknown')
    if (req.query.error || !req.query.code) return toSettings(reply, base, 'denied')
    // CSRF / flow-integrity + IDENTITY: the `state` MUST be one WE signed for THIS provider, unexpired.
    // It is the SOLE unforgeable identity binding, so it is verified FIRST and st.userId is authoritative
    // — this keeps connect working even under SameSite=Strict, where the session cookie is DROPPED on
    // the cross-site OAuth return (mirrors /auth/github/callback). A missing/forged/expired/cross-provider
    // state is refused BEFORE any token exchange.
    const st = req.query.state ? verifyConnectState(req.query.state, deps.secret) : undefined
    if (!st || st.repo !== req.params.provider) return toSettings(reply, base, 'denied')
    // DEFENSE-IN-DEPTH (Lax only): a PRESENT session cookie must match the signed-state userId; under
    // Strict the cookie is absent (cookieUser === undefined) so this is intentionally skipped.
    const cookieUser = await deps.userIdOf(req)
    if (cookieUser !== undefined && cookieUser !== st.userId) return toSettings(reply, base, 'denied')
    const provider = makeProvider(req, st.userId, req.params.provider, cfg)
    try {
      const result = await authFn(provider, { serverUrl: cfg.serverUrl, authorizationCode: req.query.code })
      if (result === 'AUTHORIZED') {
        deps.store.clearVerifier(st.userId, req.params.provider) // the transient PKCE verifier is spent
        return toSettings(reply, base, 'connected')
      }
      return toSettings(reply, base, 'error')
    } catch {
      return toSettings(reply, base, 'error')
    }
  })

  // Non-secret status — connected? (never a token).
  app.get<{ Params: { provider: string } }>('/mcp/:provider/status', async (req, reply) => {
    const userId = await deps.userIdOf(req)
    if (!userId) return reply.code(401).send({ error: 'unauthorized', code: 'Unauthorized' })
    if (!providers[req.params.provider]) return reply.code(404).send({ error: 'unknown provider', code: 'UnknownProvider' })
    const rec = deps.store.load(userId, req.params.provider)
    const tokens = rec?.tokens
    return { connected: !!tokens, ...(tokens?.scope ? { scopes: tokens.scope } : {}) }
  })

  // Disconnect — wipe the stored connection.
  app.delete<{ Params: { provider: string } }>('/mcp/:provider', async (req, reply) => {
    const userId = await deps.userIdOf(req)
    if (!userId) return reply.code(401).send({ error: 'unauthorized', code: 'Unauthorized' })
    // Validate the provider like /status + /connect do — a garbage id must 404, not silently
    // {ok:true} + a pointless store persist. Removal stays idempotent for a KNOWN-but-absent provider.
    if (!providers[req.params.provider]) return reply.code(404).send({ error: 'unknown provider', code: 'UnknownProvider' })
    deps.store.remove(userId, req.params.provider)
    return { ok: true }
  })
}

/**
 * DI factory: build a per-user, provider-backed remote-MCP transport (OAuth bearer + SDK auto-refresh)
 * for a CONNECTED provider, or undefined when the user hasn't connected it (honest absence → no MCP
 * tools, exactly like the github-stdio path degrades). The orchestrator/agent loop resolves this
 * just-in-time per session owner.
 */
export function mcpTransportFor(opts: {
  userId: string
  provider: string
  store: RemoteMcpAuthStore
  env: NodeJS.ProcessEnv
  providers?: Record<string, RemoteMcpProviderConfig>
}): HttpMcpTransport | undefined {
  const cfg = (opts.providers ?? REMOTE_MCP_PROVIDERS)[opts.provider]
  if (!cfg) return undefined
  if (!opts.store.load(opts.userId, opts.provider)?.tokens) return undefined // not connected
  const base = (opts.env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '')
  const authProvider = new StoreBackedOAuthProvider({
    userId: opts.userId, provider: opts.provider, redirectUrl: `${base}/mcp/${opts.provider}/callback`,
    scope: cfg.scope, store: opts.store, clientName: 'AKIS',
    // Same static-client rule as the connect route: github auto-refresh must present the SAME static
    // client at the token endpoint (github has no DCR), so a refresh after connect doesn't fall into
    // a failing DCR. Atlassian keeps its DCR-registered client (no staticClient).
    ...staticClientFor(opts.provider, opts.env),
  })
  return new HttpMcpTransport({ url: cfg.serverUrl, kind: cfg.kind, authProvider })
}
