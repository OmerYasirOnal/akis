import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { toPublic, type UserStorePort } from '../auth/UserStore.js'
import type { CookieConfig } from '../auth/cookie.js'
import { setSessionCookie } from '../auth/session.js'
import {
  isOAuthProvider, oauthCreds, configuredProviders, signState, verifyState,
  authorizeUrl, exchangeCode, fetchProfile, type HttpFetch,
} from '../auth/oauth.js'

export interface OAuthDeps {
  users: UserStorePort
  secret: string
  cookie: CookieConfig
  env: NodeJS.ProcessEnv
  /** Injectable HTTP for tests; defaults to global fetch. */
  http?: HttpFetch
}

/** Public base URL the browser uses (for redirect_uri + post-login redirect). Prefer
 *  PUBLIC_BASE_URL (so it matches the URI registered with the OAuth app); else derive. */
function baseUrl(req: FastifyRequest, env: NodeJS.ProcessEnv): string {
  if (env.PUBLIC_BASE_URL) return env.PUBLIC_BASE_URL.replace(/\/+$/, '')
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'http'
  const host = req.headers.host ?? '127.0.0.1:3000'
  return `${proto}://${host}`
}

export function registerOAuthRoutes(app: FastifyInstance, deps: OAuthDeps): void {
  const http: HttpFetch = deps.http ?? ((url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<HttpFetch>)
  const redirectLogin = (reply: FastifyReply, base: string, error: string): FastifyReply => reply.redirect(`${base}/login?error=${error}`)

  // FE asks which providers to show buttons for.
  app.get('/oauth/providers', async () => ({ providers: configuredProviders(deps.env) }))

  app.get<{ Params: { provider: string } }>('/oauth/:provider/authorize', async (req, reply) => {
    const provider = req.params.provider
    const base = baseUrl(req, deps.env)
    if (!isOAuthProvider(provider)) return redirectLogin(reply, base, 'oauth_unknown')
    const creds = oauthCreds(provider, deps.env)
    if (!creds) return redirectLogin(reply, base, 'oauth_unavailable')
    const state = signState(provider, deps.secret)
    const redirectUri = `${base}/oauth/${provider}/callback`
    return reply.redirect(authorizeUrl(provider, creds.clientId, redirectUri, state))
  })

  app.get<{ Params: { provider: string }; Querystring: { code?: string; state?: string; error?: string } }>('/oauth/:provider/callback', async (req, reply) => {
    const provider = req.params.provider
    const base = baseUrl(req, deps.env)
    if (!isOAuthProvider(provider)) return redirectLogin(reply, base, 'oauth_unknown')
    if (req.query.error) return redirectLogin(reply, base, 'oauth_denied')
    const { code, state } = req.query
    if (!code || !state || verifyState(state, deps.secret) !== provider) return redirectLogin(reply, base, 'oauth_state')
    const creds = oauthCreds(provider, deps.env)
    if (!creds) return redirectLogin(reply, base, 'oauth_unavailable')
    try {
      const token = await exchangeCode(provider, { code, clientId: creds.clientId, clientSecret: creds.clientSecret, redirectUri: `${base}/oauth/${provider}/callback` }, http)
      const profile = await fetchProfile(provider, token, http)
      const user = await deps.users.upsertOAuth({ email: profile.email, name: profile.name })
      setSessionCookie(reply, toPublic(user), deps.secret, deps.cookie)
      return reply.redirect(`${base}/`)
    } catch {
      return redirectLogin(reply, base, 'oauth_failed') // never leak provider/internal detail
    }
  })
}
