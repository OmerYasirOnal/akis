export type SameSite = 'lax' | 'strict' | 'none'
export interface CookieConfig { name: string; maxAgeMs: number; secure: boolean; sameSite: SameSite; domain?: string }

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** Read the session-cookie config from AUTH_COOKIE_* (matching the platform's scheme),
 *  with safe defaults for local dev. */
export function cookieConfigFromEnv(env: NodeJS.ProcessEnv): CookieConfig {
  const ss = (env.AUTH_COOKIE_SAMESITE ?? '').toLowerCase()
  return {
    name: env.AUTH_COOKIE_NAME || 'akis_session',
    maxAgeMs: Number(env.AUTH_COOKIE_MAXAGE) || 604800000, // 7d
    secure: env.AUTH_COOKIE_SECURE === 'true',
    sameSite: ss === 'strict' || ss === 'none' ? (ss as SameSite) : 'lax',
    ...(env.AUTH_COOKIE_DOMAIN ? { domain: env.AUTH_COOKIE_DOMAIN } : {}),
  }
}

/** Serialize a Set-Cookie value. HttpOnly by default (the session token must never be
 *  reachable from page JS). maxAgeMs <= 0 expires the cookie immediately (logout). */
export function serializeCookie(name: string, value: string, cfg: Partial<CookieConfig> & { httpOnly?: boolean; path?: string }): string {
  const segs = [`${name}=${value}`, `Path=${cfg.path ?? '/'}`]
  if (cfg.httpOnly !== false) segs.push('HttpOnly')
  if (cfg.maxAgeMs !== undefined) segs.push(`Max-Age=${Math.max(0, Math.floor(cfg.maxAgeMs / 1000))}`)
  if (cfg.sameSite) segs.push(`SameSite=${cap(cfg.sameSite)}`)
  if (cfg.secure) segs.push('Secure')
  if (cfg.domain) segs.push(`Domain=${cfg.domain}`)
  return segs.join('; ')
}

/** Parse a Cookie request header into a name→value map (values URL-decoded). */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i <= 0) continue
    const k = part.slice(0, i).trim()
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}
