import { createHmac, timingSafeEqual } from 'node:crypto'

/** Verified session JWT claims (HS256). `iat`/`exp` are unix seconds. */
export interface JwtClaims { sub: string; email: string; name: string; iat: number; exp: number }
/** Verified password-reset token claims — purpose-scoped so it can't act as a session. */
export interface ResetClaims { sub: string; purpose: 'pwreset'; iat: number; exp: number }

export class JwtError extends Error { constructor(m: string) { super(m); this.name = 'JwtError' } }

const enc = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
const sign = (data: string, secret: string): string => createHmac('sha256', secret).update(data).digest('base64url')
const nowSec = (): number => Math.floor(Date.now() / 1000)

function encodeToken(payload: object, secret: string): string {
  if (!secret) throw new JwtError('missing secret')
  const data = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(payload)}`
  return `${data}.${sign(data, secret)}`
}

/** Verify the HS256 signature (constant-time) and return the decoded payload. Throws
 *  JwtError on any malformed/forged token. Caller validates claims (exp/purpose/…). */
function decodeVerified(token: string, secret: string): Record<string, unknown> {
  if (!secret) throw new JwtError('missing secret')
  const parts = token.split('.')
  if (parts.length !== 3) throw new JwtError('malformed token')
  const [head, body, sig] = parts as [string, string, string]
  const expected = sign(`${head}.${body}`, secret)
  const a = Buffer.from(sig), b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new JwtError('bad signature')
  try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown> } catch { throw new JwtError('bad payload') }
}

/** Sign a compact HS256 session JWT with the shared AUTH_JWT_SECRET. ttl default 7d. */
export function signJwt(payload: { sub: string; email: string; name: string }, secret: string, ttlSeconds = 604800, now = nowSec()): string {
  return encodeToken({ ...payload, iat: now, exp: now + ttlSeconds }, secret)
}

/** Verify + decode a session JWT: signature, expiry, then required claim types. */
export function verifyJwt(token: string, secret: string, now = nowSec()): JwtClaims {
  const c = decodeVerified(token, secret) as Partial<JwtClaims>
  if (typeof c.exp !== 'number' || c.exp < now) throw new JwtError('expired')
  if (typeof c.sub !== 'string' || !c.sub) throw new JwtError('no subject')
  if (typeof c.email !== 'string' || typeof c.name !== 'string') throw new JwtError('bad claims')
  return c as JwtClaims
}

/** Sign a short-lived (default 15m) password-reset token bound to a user id. */
export function signResetToken(sub: string, secret: string, ttlSeconds = 900, now = nowSec()): string {
  return encodeToken({ sub, purpose: 'pwreset', iat: now, exp: now + ttlSeconds }, secret)
}

/** Verify a reset token: signature, expiry, and that purpose==='pwreset' (so a stolen
 *  session cookie can't be replayed here and vice-versa). */
export function verifyResetToken(token: string, secret: string, now = nowSec()): ResetClaims {
  const c = decodeVerified(token, secret) as Partial<ResetClaims>
  if (typeof c.exp !== 'number' || c.exp < now) throw new JwtError('expired')
  if (typeof c.sub !== 'string' || !c.sub) throw new JwtError('no subject')
  if (c.purpose !== 'pwreset') throw new JwtError('wrong purpose')
  return c as ResetClaims
}
