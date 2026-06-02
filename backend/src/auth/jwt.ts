import { createHmac, timingSafeEqual } from 'node:crypto'

/** Verified JWT claims (HS256). `iat`/`exp` are unix seconds. */
export interface JwtClaims { sub: string; email: string; name: string; iat: number; exp: number }

export class JwtError extends Error { constructor(m: string) { super(m); this.name = 'JwtError' } }

const enc = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
const sign = (data: string, secret: string): string => createHmac('sha256', secret).update(data).digest('base64url')
const nowSec = (): number => Math.floor(Date.now() / 1000)

/**
 * Sign a compact HS256 JWT with Node's crypto (no external dep). The signing key is
 * the shared AUTH_JWT_SECRET so tokens are interoperable with the platform's scheme.
 * ttl defaults to 7 days. `now` is injectable for deterministic tests.
 */
export function signJwt(payload: { sub: string; email: string; name: string }, secret: string, ttlSeconds = 604800, now = nowSec()): string {
  if (!secret) throw new JwtError('missing secret')
  const head = enc({ alg: 'HS256', typ: 'JWT' })
  const body = enc({ ...payload, iat: now, exp: now + ttlSeconds })
  const data = `${head}.${body}`
  return `${data}.${sign(data, secret)}`
}

/**
 * Verify + decode an HS256 JWT: constant-time signature check, then expiry. Throws
 * JwtError on any malformed/forged/expired token (never returns partial claims).
 */
export function verifyJwt(token: string, secret: string, now = nowSec()): JwtClaims {
  if (!secret) throw new JwtError('missing secret')
  const parts = token.split('.')
  if (parts.length !== 3) throw new JwtError('malformed token')
  const [head, body, sig] = parts as [string, string, string]
  const expected = sign(`${head}.${body}`, secret)
  const a = Buffer.from(sig), b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new JwtError('bad signature')
  let claims: JwtClaims
  try { claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as JwtClaims } catch { throw new JwtError('bad payload') }
  if (typeof claims.exp !== 'number' || claims.exp < now) throw new JwtError('expired')
  if (typeof claims.sub !== 'string' || !claims.sub) throw new JwtError('no subject')
  if (typeof claims.email !== 'string' || typeof claims.name !== 'string') throw new JwtError('bad claims')
  return claims
}
