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
  /** When true (the prod single-user posture), OAuth may LINK/LOG-IN an existing account but must
   *  NOT create a new one — otherwise OAuth silently bypasses the no-open-signup gate (the
   *  no-sandbox RCE guard) that POST /auth/signup enforces. Mirrors resolveSignupDisabled(env). */
  signupDisabled?: boolean
  /** Injectable HTTP for tests; defaults to global fetch. */
  http?: HttpFetch
}

/** Public base URL the browser uses (for redirect_uri + post-login redirect). Prefer
 *  PUBLIC_BASE_URL (so it matches the URI registered with the OAuth app); else derive.
 *  EXPORTED so the per-user GitHub connect routes reuse the exact same origin logic. */
export function baseUrl(req: FastifyRequest, env: NodeJS.ProcessEnv): string {
  // Prefer the explicitly-configured public origin (the value registered with the OAuth
  // app). Only fall back to forwarded/host headers in dev — they are client-controlled.
  if (env.PUBLIC_BASE_URL) return env.PUBLIC_BASE_URL.replace(/\/+$/, '')
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'http'
  const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host ?? '127.0.0.1:3000'
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
      const { token } = await exchangeCode(provider, { code, clientId: creds.clientId, clientSecret: creds.clientSecret, redirectUri: `${base}/oauth/${provider}/callback` }, http)
      const profile = await fetchProfile(provider, token, http)
      // DEFENSE-IN-DEPTH (single-user): an explicit owner allowlist — when AKIS_OWNER_EMAIL is set,
      // ONLY that (provider-verified) email may authenticate at all, so even with creds configured no
      // one else can sign in. Refusal is generic (no account-existence leak).
      const ownerEmail = (deps.env.AKIS_OWNER_EMAIL ?? '').trim().toLowerCase()
      if (ownerEmail && profile.email.trim().toLowerCase() !== ownerEmail) return redirectLogin(reply, base, 'oauth_denied')
      // GATE creation behind the signup-disabled policy: link/log-in an existing account, but never
      // CREATE a new one when signup is closed (else OAuth bypasses the no-sandbox-RCE signup gate).
      const user = await deps.users.upsertOAuth(
        { externalId: profile.externalId, email: profile.email, name: profile.name },
        { allowCreate: !deps.signupDisabled },
      )
      if (!user) return redirectLogin(reply, base, 'oauth_denied') // creation refused — signup is closed
      setSessionCookie(reply, toPublic(user), deps.secret, deps.cookie, user.tokenVersion ?? 0) // explicit tv (review #112): OAuth sessions revoke identically
      return reply.redirect(`${base}/`)
    } catch {
      return redirectLogin(reply, base, 'oauth_failed') // never leak provider/internal detail
    }
  })
}
