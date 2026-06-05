import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto'

export type OAuthProviderId = 'github' | 'google'
export const OAUTH_PROVIDERS: OAuthProviderId[] = ['github', 'google']

/** Minimal normalized profile we need to find-or-create a user. */
export interface OAuthProfile { externalId: string; email: string; name: string }

/** Injected HTTP (global fetch in prod; a stub in tests). */
export type HttpFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>

interface ProviderDef {
  authorizeUrl: string
  tokenUrl: string
  scope: string
  idEnv: string
  secretEnv: string
}

const DEFS: Record<OAuthProviderId, ProviderDef> = {
  github: {
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scope: 'read:user user:email',
    idEnv: 'GITHUB_OAUTH_CLIENT_ID',
    secretEnv: 'GITHUB_OAUTH_CLIENT_SECRET',
  },
  google: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
    idEnv: 'GOOGLE_OAUTH_CLIENT_ID',
    secretEnv: 'GOOGLE_OAUTH_CLIENT_SECRET',
  },
}

export function isOAuthProvider(p: string): p is OAuthProviderId { return p === 'github' || p === 'google' }

/** Client credentials for a provider, or undefined when not configured. */
export function oauthCreds(provider: OAuthProviderId, env: NodeJS.ProcessEnv): { clientId: string; clientSecret: string } | undefined {
  const def = DEFS[provider]
  const clientId = env[def.idEnv], clientSecret = env[def.secretEnv]
  return clientId && clientSecret ? { clientId, clientSecret } : undefined
}

/** Which providers are usable right now (creds present) — drives the FE buttons. */
export function configuredProviders(env: NodeJS.ProcessEnv): OAuthProviderId[] {
  return OAUTH_PROVIDERS.filter(p => oauthCreds(p, env) !== undefined)
}

// ── Stateless, HMAC-signed `state` (CSRF + provider binding); no server storage. ──
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
const mac = (data: string, secret: string): string => createHmac('sha256', secret).update(data).digest('base64url')

export function signState(provider: OAuthProviderId, secret: string, ttlSeconds = 600, now = Math.floor(Date.now() / 1000)): string {
  const body = b64({ p: provider, n: randomBytes(8).toString('hex'), exp: now + ttlSeconds })
  return `${body}.${mac(body, secret)}`
}

export function verifyState(state: string, secret: string, now = Math.floor(Date.now() / 1000)): OAuthProviderId | undefined {
  const parts = state.split('.')
  if (parts.length !== 2) return undefined
  const [body, sig] = parts as [string, string]
  const expected = mac(body, secret)
  const a = Buffer.from(sig), b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined
  try {
    const o = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { p?: string; exp?: number }
    if (typeof o.exp !== 'number' || o.exp < now) return undefined
    return o.p && isOAuthProvider(o.p) ? o.p : undefined
  } catch { return undefined }
}

// ── CONNECT-state: HMAC-signed, carries the userId + repo target (CSRF + identity). ──
// The browser round-trips github.com → AKIS on the callback; under SameSite=Strict the
// session cookie is DROPPED, so the cookie alone cannot identify the user. We therefore
// bind the userId AND the repo INSIDE the MAC'd body — neither can be swapped/tampered
// without invalidating the signature. This is the SOLE, UNFORGEABLE identity/CSRF/target
// binding. Same envelope/secret as signState. TTL is tight (≤600s) to bound replay (there
// is no single-use nonce store — deferred).
export function signConnectState(userId: string, repo: string, secret: string, ttlSeconds = 600, now = Math.floor(Date.now() / 1000)): string {
  const body = b64({ u: userId, r: repo, n: randomBytes(8).toString('hex'), exp: now + ttlSeconds })
  return `${body}.${mac(body, secret)}`
}

export function verifyConnectState(state: string, secret: string, now = Math.floor(Date.now() / 1000)): { userId: string; repo: string } | undefined {
  const parts = state.split('.')
  if (parts.length !== 2) return undefined
  const [body, sig] = parts as [string, string]
  const expected = mac(body, secret)
  const a = Buffer.from(sig), b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined
  try {
    const o = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { u?: string; r?: string; exp?: number }
    if (typeof o.exp !== 'number' || o.exp < now) return undefined
    if (typeof o.u !== 'string' || !o.u || typeof o.r !== 'string' || !o.r) return undefined
    return { userId: o.u, repo: o.r }
  } catch { return undefined }
}

/** The scope a per-user CONNECT requires — branch+PR push needs write to the target repo.
 *  (Login uses the narrower DEFS.github.scope; the two flows share the same GitHub app.) */
export const githubConnectScope = 'repo'

/** The provider authorize URL to redirect the browser to. `scopeOverride` is used ONLY by
 *  the connect route (to request the broader `repo` scope); it DEFAULTS to the provider's
 *  login scope so the existing login authorize call is byte-identical. */
export function authorizeUrl(provider: OAuthProviderId, clientId: string, redirectUri: string, state: string, scopeOverride?: string): string {
  const def = DEFS[provider]
  const scope = scopeOverride ?? def.scope
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, scope, state, response_type: 'code' })
  if (provider === 'github') q.set('allow_signup', 'true')
  return `${def.authorizeUrl}?${q.toString()}`
}

/** Exchange an auth code for an access token + the granted scopes. Returns `{token, scopes}`:
 *  the scope string GitHub returns (space- or comma-delimited) is parsed to string[], FAIL-
 *  CLOSED to [] when absent (never throws on a missing scope). Neither token nor scope is
 *  ever logged. */
export async function exchangeCode(provider: OAuthProviderId, args: { code: string; clientId: string; clientSecret: string; redirectUri: string }, http: HttpFetch): Promise<{ token: string; scopes: string[] }> {
  const def = DEFS[provider]
  const body = new URLSearchParams({ client_id: args.clientId, client_secret: args.clientSecret, code: args.code, redirect_uri: args.redirectUri, grant_type: 'authorization_code' }).toString()
  const res = await http(def.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body })
  if (!res.ok) throw new Error(`token exchange failed (${res.status})`)
  const json = (await res.json()) as { access_token?: string; scope?: string }
  if (!json.access_token) throw new Error('no access_token in token response')
  const scopes = String(json.scope ?? '').split(/[ ,]+/).filter(Boolean)
  return { token: json.access_token, scopes }
}

/** Fetch the GitHub `login` (the @handle) for display on the connection card. A dedicated
 *  helper rather than mutating fetchProfile (which folds `login` into the normalized `name`
 *  and is shared by the login path). Token-free errors; returns '' on any failure. */
export async function fetchGitHubLogin(accessToken: string, http: HttpFetch): Promise<string> {
  const auth = { authorization: `Bearer ${accessToken}`, accept: 'application/json', 'user-agent': 'akis-studio' }
  try {
    const u = (await (await http('https://api.github.com/user', { headers: auth })).json()) as { login?: string }
    return typeof u.login === 'string' ? u.login : ''
  } catch {
    return ''
  }
}

/** Fetch + normalize the user's profile. */
export async function fetchProfile(provider: OAuthProviderId, accessToken: string, http: HttpFetch): Promise<OAuthProfile> {
  const auth = { authorization: `Bearer ${accessToken}`, accept: 'application/json', 'user-agent': 'akis-studio' }
  if (provider === 'github') {
    const u = (await (await http('https://api.github.com/user', { headers: auth })).json()) as { id?: number; login?: string; name?: string; email?: string | null }
    let email = u.email ?? ''
    if (!email) {
      const emails = (await (await http('https://api.github.com/user/emails', { headers: auth })).json().catch(() => [])) as { email: string; primary: boolean; verified: boolean }[]
      email = (Array.isArray(emails) ? emails.find(e => e.primary && e.verified) ?? emails.find(e => e.verified) : undefined)?.email ?? ''
    }
    if (!u.id || !email) throw new Error('github profile missing id/email')
    return { externalId: `github:${u.id}`, email, name: (u.name || u.login || email.split('@')[0]) as string }
  }
  // google
  const g = (await (await http('https://www.googleapis.com/oauth2/v3/userinfo', { headers: auth })).json()) as { sub?: string; email?: string; name?: string; email_verified?: boolean | string }
  if (!g.sub || !g.email) throw new Error('google profile missing sub/email')
  // REQUIRE a provider-verified email (Google may serialize the flag as a string).
  // Without this, an attacker-asserted unverified email could link to a victim account.
  if (g.email_verified !== true && g.email_verified !== 'true') throw new Error('google email not verified')
  return { externalId: `google:${g.sub}`, email: g.email, name: g.name || g.email.split('@')[0]! }
}
