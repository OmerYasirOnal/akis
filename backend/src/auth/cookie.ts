export type SameSite = 'lax' | 'strict' | 'none'
export interface CookieConfig { name: string; maxAgeMs: number; secure: boolean; sameSite: SameSite; domain?: string }

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** Read the session-cookie config from AUTH_COOKIE_* (matching the platform's scheme),
 *  with safe defaults for local dev. */
export function cookieConfigFromEnv(env: NodeJS.ProcessEnv): CookieConfig {
  const ss = (env.AUTH_COOKIE_SAMESITE ?? '').toLowerCase()
  const sameSite: SameSite = ss === 'strict' || ss === 'none' ? (ss as SameSite) : 'lax'
  // AUTH_COOKIE_MAXAGE is in SECONDS (the platform's convention, e.g. 604800 = 7d).
  const maxAgeSec = Number(env.AUTH_COOKIE_MAXAGE) || 604800
  return {
    name: env.AUTH_COOKIE_NAME || 'akis_session',
    maxAgeMs: maxAgeSec * 1000,
    // SameSite=None cookies MUST be Secure or browsers drop them — force it.
    secure: env.AUTH_COOKIE_SECURE === 'true' || sameSite === 'none',
    sameSite,
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
    if (!k) continue
    const raw = part.slice(i + 1).trim()
    // Tolerate malformed percent-encoding (e.g. "%zz") on an attacker-controlled
    // header: fall back to the raw value rather than throwing into the caller.
    try { out[k] = decodeURIComponent(raw) } catch { out[k] = raw }
  }
  return out
}
