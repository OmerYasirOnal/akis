import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { StoreBackedOAuthProvider, type RemoteMcpAuthStore } from '../agent/mcp/StoreBackedOAuthProvider.js'
import { HttpMcpTransport } from '../agent/mcp/HttpMcpTransport.js'
import { baseUrl } from './oauth.routes.js'

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
    scope: 'offline_access read:me read:jira-work write:jira-work read:confluence-content.all write:confluence-content read:confluence-space.summary',
  },
  github: {
    serverUrl: 'https://api.githubcopilot.com/mcp/',
    kind: 'streamable-http',
    scope: '', // GitHub's hosted client negotiates scope; left empty so the SDK uses the server default
  },
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
    new StoreBackedOAuthProvider({ userId, provider: name, redirectUrl: `${baseUrl(req, deps.env)}/mcp/${name}/callback`, scope: cfg.scope, store: deps.store, clientName: 'AKIS' })

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
      if (result === 'REDIRECT' && provider.capturedAuthorizationUrl) return reply.redirect(provider.capturedAuthorizationUrl.toString())
      if (result === 'AUTHORIZED') return toSettings(reply, base, 'connected') // already authorized (cached tokens)
      return toSettings(reply, base, 'error')
    } catch {
      return toSettings(reply, base, 'error') // token-free — never echo the underlying error
    }
  })

  // OAuth redirect target: exchange the code (PKCE) → saveTokens (in the provider).
  app.get<{ Params: { provider: string }; Querystring: { code?: string; state?: string; error?: string } }>('/mcp/:provider/callback', async (req, reply) => {
    const base = baseUrl(req, deps.env)
    const userId = await deps.userIdOf(req)
    if (!userId) return reply.code(401).send({ error: 'unauthorized', code: 'Unauthorized' })
    const cfg = providers[req.params.provider]
    if (!cfg) return toSettings(reply, base, 'unknown')
    if (req.query.error || !req.query.code) return toSettings(reply, base, 'denied')
    const provider = makeProvider(req, userId, req.params.provider, cfg)
    try {
      const result = await authFn(provider, { serverUrl: cfg.serverUrl, authorizationCode: req.query.code })
      if (result === 'AUTHORIZED') {
        deps.store.clearVerifier(userId, req.params.provider) // the transient PKCE verifier is spent
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
  })
  return new HttpMcpTransport({ url: cfg.serverUrl, kind: cfg.kind, authProvider })
}
