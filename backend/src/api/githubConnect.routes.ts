import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { GitHubConnectionStore } from '../keys/GitHubConnectionStore.js'
import type { CookieConfig } from '../auth/cookie.js'
import {
  oauthCreds, signConnectState, verifyConnectState, authorizeUrl, exchangeCode,
  fetchGitHubLogin, githubConnectScope, type HttpFetch,
} from '../auth/oauth.js'
import { parseOwnerRepo } from '../di/selectGitHubAdapter.js'
import { baseUrl } from './oauth.routes.js'

export interface GitHubConnectDeps {
  connections: GitHubConnectionStore
  secret: string
  cookie: CookieConfig
  env: NodeJS.ProcessEnv
  /** Resolve the signed-in user id (undefined when unauthenticated) — the SAME closure
   *  the rest of the server uses (revocation-aware). */
  userIdOf: (req: FastifyRequest) => Promise<string | undefined>
  /** Injectable HTTP for tests; defaults to global fetch. */
  http?: HttpFetch
}

/**
 * Per-user GitHub connection (security-first). A signed-in user connects THEIR GitHub
 * account so the ALREADY-GATED push delivers to a repo THEY own — replacing the server-wide
 * env token as the PREFERRED credential ONLY when the session owner has a live connection.
 *
 * This route NEVER touches the push gate's semantics: it stores a per-user token (encrypted)
 * + the target repo; confirmPush still pushes only through the unchanged ApprovedPush path.
 *
 * Token discipline: the access token NEVER appears in any URL, log line, or response body.
 * The callback redirects with only `?github=connected|error|denied|unavailable`. This route
 * has NO `users` dep — it never mints a session cookie or mutates a user.
 */
export function registerGitHubConnectRoutes(app: FastifyInstance, deps: GitHubConnectDeps): void {
  const http: HttpFetch = deps.http ?? ((url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<HttpFetch>)
  const toSettings = (reply: FastifyReply, base: string, status: string): FastifyReply => reply.redirect(`${base}/settings?github=${status}`)

  // Begin the connect flow: authenticated, with a valid target repo + encryption configured.
  app.get<{ Querystring: { repo?: string } }>('/auth/github/connect', async (req, reply) => {
    const base = baseUrl(req, deps.env)
    const userId = await deps.userIdOf(req)
    if (!userId) return reply.code(401).send({ error: 'unauthorized', code: 'Unauthorized' })

    // The repo is now UNTRUSTED user input — shape-validate before going anywhere.
    const target = parseOwnerRepo(req.query.repo)
    if (!target) return reply.code(400).send({ error: 'repo must be "owner/name"', code: 'BadRepo' })

    // FAIL-CLOSED PREFLIGHT — refuse BEFORE minting a GitHub authorization we can't complete:
    //  (a) the GitHub OAuth app must be configured, and
    //  (b) encryption must be configured (else encryptSecret would throw at storage time,
    //      burning a live `repo`-scoped authorization). canStore() is a non-throwing probe.
    if (!oauthCreds('github', deps.env)) return toSettings(reply, base, 'unavailable')
    if (!deps.connections.canStore()) return toSettings(reply, base, 'unavailable')

    const repo = `${target.owner}/${target.repo}`
    // userId + repo are bound INSIDE the signed state — the unforgeable identity/CSRF/target
    // binding (the callback derives both from it, never from a token-in-URL).
    const state = signConnectState(userId, repo, deps.secret)
    const creds = oauthCreds('github', deps.env)! // present per the preflight above
    const redirectUri = `${base}/auth/github/callback`
    return reply.redirect(authorizeUrl('github', creds.clientId, redirectUri, state, githubConnectScope))
  })

  // GitHub redirects the browser back here (a cross-site top-level GET).
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>('/auth/github/callback', async (req, reply) => {
    const base = baseUrl(req, deps.env)
    if (req.query.error) return toSettings(reply, base, 'denied')
    const { code, state } = req.query
    const verified = state ? verifyConnectState(state, deps.secret) : undefined
    if (!code || !verified) return toSettings(reply, base, 'error')

    // DEFENSE-IN-DEPTH (Lax only): if a session cookie rode along, it MUST match the signed
    // state's userId. Under SameSite=Strict the cookie is dropped (cookieUser === undefined),
    // so this check is intentionally SKIPPED — the signed state is already an unforgeable
    // userId binding, so a missing cookie does not weaken identity.
    const cookieUser = await deps.userIdOf(req)
    if (cookieUser !== undefined && cookieUser !== verified.userId) return toSettings(reply, base, 'error')

    const creds = oauthCreds('github', deps.env)
    if (!creds) return toSettings(reply, base, 'unavailable')
    try {
      const { token, scopes } = await exchangeCode('github', { code, clientId: creds.clientId, clientSecret: creds.clientSecret, redirectUri: `${base}/auth/github/callback` }, http)
      const username = await fetchGitHubLogin(token, http)
      // set() may (defensively) throw if encryption became unavailable between preflight and
      // here — surface a token-free ?github=error rather than a 500 that could echo internals.
      deps.connections.set(verified.userId, { accessToken: token, username, scopes, repo: verified.repo })
      return toSettings(reply, base, 'connected')
    } catch {
      return toSettings(reply, base, 'error') // never leak the token or any internal detail
    }
  })

  // The caller's connection status — drives the Settings card. NEVER returns the token.
  app.get('/auth/github/status', async (req, reply) => {
    const userId = await deps.userIdOf(req)
    if (!userId) return reply.code(401).send({ error: 'unauthorized', code: 'Unauthorized' })
    const c = deps.connections.status(userId)
    // `configured` reflects BOTH the OAuth app AND encryption (canStore) — so the FE never
    // shows a Connect button that would fail at storage time.
    const configured = !!oauthCreds('github', deps.env) && deps.connections.canStore()
    return { connected: !!c, configured, ...(c ?? {}) }
  })

  // Remove the caller's stored connection.
  app.delete('/auth/github', async (req, reply) => {
    const userId = await deps.userIdOf(req)
    if (!userId) return reply.code(401).send({ error: 'unauthorized', code: 'Unauthorized' })
    deps.connections.remove(userId)
    return { removed: true }
  })
}
