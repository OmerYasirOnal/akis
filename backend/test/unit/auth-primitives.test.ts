import { describe, it, expect } from 'vitest'
import { signJwt, verifyJwt, JwtError } from '../../src/auth/jwt.js'
import { hashPassword, verifyPassword } from '../../src/auth/password.js'
import { serializeCookie, parseCookies, cookieConfigFromEnv } from '../../src/auth/cookie.js'
import { UserStore, EmailTakenError, toPublic } from '../../src/auth/UserStore.js'

describe('jwt (HS256, Node crypto)', () => {
  const secret = 'test-secret-abc'
  it('round-trips claims and sets iat/exp', () => {
    const t = signJwt({ sub: 'u1', email: 'a@b.com', name: 'A' }, secret, 100, 1000)
    const c = verifyJwt(t, secret, 1050)
    expect(c.sub).toBe('u1'); expect(c.email).toBe('a@b.com'); expect(c.iat).toBe(1000); expect(c.exp).toBe(1100)
  })
  it('rejects a tampered payload (signature mismatch)', () => {
    const t = signJwt({ sub: 'u1', email: 'a@b.com', name: 'A' }, secret, 100, 1000)
    const [h, , s] = t.split('.')
    const forged = `${h}.${Buffer.from(JSON.stringify({ sub: 'admin', email: 'x', name: 'x', iat: 1000, exp: 9999999999 })).toString('base64url')}.${s}`
    expect(() => verifyJwt(forged, secret)).toThrow(JwtError)
  })
  it('rejects a token signed with a different secret', () => {
    const t = signJwt({ sub: 'u1', email: 'a@b.com', name: 'A' }, secret)
    expect(() => verifyJwt(t, 'other-secret')).toThrow(JwtError)
  })
  it('rejects an expired token', () => {
    const t = signJwt({ sub: 'u1', email: 'a@b.com', name: 'A' }, secret, 10, 1000)
    expect(() => verifyJwt(t, secret, 2000)).toThrow(/expired/)
  })
})

describe('password (scrypt)', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const h = await hashPassword('correct horse battery')
    expect(h.startsWith('scrypt$')).toBe(true)
    expect(await verifyPassword('correct horse battery', h)).toBe(true)
    expect(await verifyPassword('wrong', h)).toBe(false)
  })
  it('produces a unique salt per hash (no rainbow reuse)', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'))
  })
  it('returns false (never throws) on a malformed hash record', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false)
    expect(await verifyPassword('x', 'scrypt$bad')).toBe(false)
  })
})

describe('cookie helpers', () => {
  it('serializes an httpOnly session cookie with attributes', () => {
    const c = serializeCookie('akis_session', 'tok', { maxAgeMs: 1000, secure: true, sameSite: 'lax' })
    expect(c).toContain('akis_session=tok')
    expect(c).toContain('HttpOnly'); expect(c).toContain('Secure'); expect(c).toContain('SameSite=Lax'); expect(c).toContain('Max-Age=1')
  })
  it('logout cookie expires immediately (Max-Age=0)', () => {
    expect(serializeCookie('akis_session', '', { maxAgeMs: 0 })).toContain('Max-Age=0')
  })
  it('parses a Cookie header into a map', () => {
    expect(parseCookies('a=1; akis_session=xyz; b=2').akis_session).toBe('xyz')
    expect(parseCookies(undefined)).toEqual({})
  })
  it('reads config from AUTH_COOKIE_* with safe defaults', () => {
    expect(cookieConfigFromEnv({}).name).toBe('akis_session')
    const c = cookieConfigFromEnv({ AUTH_COOKIE_NAME: 'sess', AUTH_COOKIE_SECURE: 'true', AUTH_COOKIE_SAMESITE: 'strict' })
    expect(c.name).toBe('sess'); expect(c.secure).toBe(true); expect(c.sameSite).toBe('strict')
  })
})

describe('UserStore', () => {
  it('creates, finds, and rejects duplicate emails (case-insensitive)', async () => {
    const s = new UserStore()
    const u = await s.create({ name: 'A', email: 'A@B.com', passwordHash: 'h' })
    expect((await s.findByEmail('a@b.com'))?.id).toBe(u.id)
    await expect(s.create({ name: 'A2', email: 'a@b.com', passwordHash: 'h2' })).rejects.toBeInstanceOf(EmailTakenError)
  })
  it('toPublic never leaks the password hash', () => {
    expect(toPublic({ id: '1', name: 'A', email: 'a@b.com', passwordHash: 'secret', createdAt: 'x' })).not.toHaveProperty('passwordHash')
  })
})
