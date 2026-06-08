import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { signJwt, verifyJwt, signResetToken, verifyResetToken, JwtError } from '../../src/auth/jwt.js'
import { hashPassword, verifyPassword } from '../../src/auth/password.js'
import { serializeCookie, parseCookies, cookieConfigFromEnv } from '../../src/auth/cookie.js'
import { UserStore, EmailTakenError, toPublic, providerOf, type AuthUser } from '../../src/auth/UserStore.js'

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
  it('rejects a correctly-signed token whose body is not valid JSON (bad payload)', () => {
    // Forge a token where the signature is VALID for the (garbage) body — the only thing
    // standing between an attacker and a crash/forgery is the JSON.parse guard, which must
    // fail closed with JwtError rather than throwing a raw SyntaxError into the caller.
    const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const body = Buffer.from('not-json{').toString('base64url')
    const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')
    expect(() => verifyJwt(`${head}.${body}.${sig}`, secret)).toThrow(JwtError)
  })
  it('rejects a session token missing the subject claim (no privilege without identity)', () => {
    // Validly signed, unexpired, but sub is absent — must NOT yield an authenticated identity.
    const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const body = Buffer.from(JSON.stringify({ email: 'a@b.com', name: 'A', iat: 1000, exp: 9999999999 })).toString('base64url')
    const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')
    expect(() => verifyJwt(`${head}.${body}.${sig}`, secret, 1100)).toThrow(/no subject/)
  })
  it('rejects a session token with a non-string email/name claim (bad claims)', () => {
    const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const body = Buffer.from(JSON.stringify({ sub: 'u1', email: 42, name: 'A', iat: 1000, exp: 9999999999 })).toString('base64url')
    const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')
    expect(() => verifyJwt(`${head}.${body}.${sig}`, secret, 1100)).toThrow(/bad claims/)
    // Pin the OTHER arm of the OR guard independently — email valid, name non-string. Without
    // this, a mutation dropping the name check would stay green (review follow-up).
    const body2 = Buffer.from(JSON.stringify({ sub: 'u1', email: 'a@b.com', name: 42, iat: 1000, exp: 9999999999 })).toString('base64url')
    const sig2 = createHmac('sha256', secret).update(`${head}.${body2}`).digest('base64url')
    expect(() => verifyJwt(`${head}.${body2}.${sig2}`, secret, 1100)).toThrow(/bad claims/)
  })
  it('signing requires a secret (no silent unsigned tokens)', () => {
    expect(() => signJwt({ sub: 'u1', email: 'a@b.com', name: 'A' }, '')).toThrow(/missing secret/)
  })

  it('reset token: round-trips, enforces purpose, and is not usable as a session', () => {
    const rt = signResetToken('u1', secret, 900, 1000)
    expect(verifyResetToken(rt, secret, 1100).sub).toBe('u1')
    // A reset token must NOT verify as a session JWT (missing email/name claims).
    expect(() => verifyJwt(rt, secret, 1100)).toThrow(JwtError)
    // A session JWT must NOT verify as a reset token (wrong purpose).
    const sess = signJwt({ sub: 'u1', email: 'a@b.com', name: 'A' }, secret, 900, 1000)
    expect(() => verifyResetToken(sess, secret, 1100)).toThrow(/purpose/)
  })
  it('reset token expires', () => {
    const rt = signResetToken('u1', secret, 10, 1000)
    expect(() => verifyResetToken(rt, secret, 2000)).toThrow(/expired/)
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
  it('rejects a record with a non-integer or out-of-range cost (no scrypt invocation)', async () => {
    // A hostile/corrupt record could carry an absurd or non-numeric N. The cost guard must
    // reject BEFORE handing it to scrypt, so it can neither crash nor be used as a CPU-DoS lever.
    expect(await verifyPassword('x', 'scrypt$notnum$c2FsdA$aGFzaA')).toBe(false) // NaN cost
    expect(await verifyPassword('x', 'scrypt$1$c2FsdA$aGFzaA')).toBe(false)       // cost < 2
  })
  it('rejects a record with an empty salt or empty hash segment', async () => {
    // Empty base64url decodes to a 0-length buffer; verify must fail closed rather than
    // run scrypt against an empty salt or timingSafeEqual against an empty digest.
    expect(await verifyPassword('x', 'scrypt$16384$$aGFzaA')).toBe(false) // empty salt
    expect(await verifyPassword('x', 'scrypt$16384$c2FsdA$')).toBe(false) // empty hash
  })
  it('returns false (never throws) when scrypt rejects the parameters', async () => {
    // A record whose cost is a valid integer but not a power of two makes Node's scrypt throw.
    // The try/catch must absorb it into a plain false — a bad record is a failed login, not a 500.
    // NOTE: this relies on Node's scrypt validating N as a power of two (undocumented-ish invariant);
    // if a future Node relaxes it, this flips to a plain wrong-password false — same observable
    // result, but the try/catch arm would no longer be exercised by this case.
    expect(await verifyPassword('x', 'scrypt$3$c2FsdA$aGFzaA')).toBe(false)
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
    expect(cookieConfigFromEnv({}).maxAgeMs).toBe(604800000) // 7d default
    const c = cookieConfigFromEnv({ AUTH_COOKIE_NAME: 'sess', AUTH_COOKIE_SECURE: 'true', AUTH_COOKIE_SAMESITE: 'strict' })
    expect(c.name).toBe('sess'); expect(c.secure).toBe(true); expect(c.sameSite).toBe('strict')
  })
  it('interprets AUTH_COOKIE_MAXAGE as SECONDS (platform convention)', () => {
    expect(cookieConfigFromEnv({ AUTH_COOKIE_MAXAGE: '604800' }).maxAgeMs).toBe(604800000) // 7d, not 604s
  })
  it('forces Secure when SameSite=None (browsers drop None without Secure)', () => {
    const c = cookieConfigFromEnv({ AUTH_COOKIE_SAMESITE: 'none', AUTH_COOKIE_SECURE: 'false' })
    expect(c.sameSite).toBe('none'); expect(c.secure).toBe(true)
  })
  it('parseCookies tolerates malformed percent-encoding (no throw on attacker input)', () => {
    expect(() => parseCookies('akis_session=%zz; x=ok')).not.toThrow()
    expect(parseCookies('akis_session=%zz; x=ok').x).toBe('ok')
  })
  it('threads AUTH_COOKIE_DOMAIN through config and into the Set-Cookie Domain attribute', () => {
    // A misconfigured Domain scopes the session cookie to the wrong host (it can leak the
    // session to sibling subdomains, or fail to send at all) — pin that the env value lands
    // verbatim on both the config and the serialized header.
    const cfg = cookieConfigFromEnv({ AUTH_COOKIE_DOMAIN: 'akisflow.com' })
    expect(cfg.domain).toBe('akisflow.com')
    expect(serializeCookie('akis_session', 'tok', cfg)).toContain('Domain=akisflow.com')
  })
  it('an ABSENT AUTH_COOKIE_DOMAIN yields no domain key and no Domain= attribute (fail-safe default)', () => {
    // The inverse of the test above (review follow-up): host-only cookies are the safe default —
    // a stray Domain= would widen the cookie to sibling subdomains.
    const cfg = cookieConfigFromEnv({})
    expect('domain' in cfg).toBe(false)
    expect(serializeCookie('akis_session', 'tok', cfg)).not.toContain('Domain=')
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
  it('providerOf derives the login provider from the externalId namespace', () => {
    expect(providerOf('github:42')).toBe('github')
    expect(providerOf('google:abc')).toBe('google')
    expect(providerOf(undefined)).toBe('password')   // no externalId ⇒ password account
    expect(providerOf('')).toBe('password')
    expect(providerOf('saml:weird')).toBe('password') // unknown namespace ⇒ password (fail-safe)
  })
  it('toPublic projects provider + avatarUrl (the FE login projection contract)', () => {
    const base = { id: '1', name: 'A', email: 'a@b.com', passwordHash: 'secret', createdAt: 'x' } satisfies Partial<AuthUser>
    // password account: provider 'password', no avatarUrl key at all (exactOptionalPropertyTypes).
    const pw = toPublic({ ...base })
    expect(pw).toEqual({ id: '1', name: 'A', email: 'a@b.com', provider: 'password' })
    expect('avatarUrl' in pw).toBe(false)
    // github with an avatar passes both through
    expect(toPublic({ ...base, externalId: 'github:7', avatarUrl: 'https://av/gh' }))
      .toEqual({ id: '1', name: 'A', email: 'a@b.com', provider: 'github', avatarUrl: 'https://av/gh' })
    // google without an avatar derives the provider but omits avatarUrl
    const g = toPublic({ ...base, externalId: 'google:9' })
    expect(g).toEqual({ id: '1', name: 'A', email: 'a@b.com', provider: 'google' })
    expect('avatarUrl' in g).toBe(false)
  })
  it('upsertOAuth binds by externalId and links a (verified) email account to that identity', async () => {
    const s = new UserStore()
    const a = await s.upsertOAuth({ externalId: 'github:1', email: 'ada@akis.dev', name: 'Ada' }) // allowCreate defaults true → never null here
    expect(a).not.toBeNull()
    // same identity returns the same user
    expect((await s.upsertOAuth({ externalId: 'github:1', email: 'ada@akis.dev', name: 'Ada' }))?.id).toBe(a?.id)
    // a password account is linked to the identity when the (verified) email matches
    const pw = await s.create({ name: 'Bo', email: 'bo@akis.dev', passwordHash: 'h' })
    const linked = await s.upsertOAuth({ externalId: 'google:2', email: 'BO@akis.dev', name: 'Bo' })
    expect(linked?.id).toBe(pw.id)
    expect((await s.findById(pw.id))?.externalId).toBe('google:2')
  })
  it('upsertOAuth sets avatarUrl on create and surfaces it via toPublic', async () => {
    const s = new UserStore()
    const u = await s.upsertOAuth({ externalId: 'github:5', email: 'pic@akis.dev', name: 'Pic', avatarUrl: 'https://av/5' })
    expect(u?.avatarUrl).toBe('https://av/5')
    expect(toPublic(u!)).toMatchObject({ provider: 'github', avatarUrl: 'https://av/5' })
  })
  it('upsertOAuth returning identity REFRESHES the avatar when the profile carries a new one', async () => {
    // An owner who first logged in before avatars (no picture stored) must get their photo
    // on the next login — the returning-identity path now refreshes rather than returning early.
    const s = new UserStore()
    await s.upsertOAuth({ externalId: 'github:42', email: 'own@akis.dev', name: 'Owner' }) // no avatar yet
    const refreshed = await s.upsertOAuth({ externalId: 'github:42', email: 'own@akis.dev', name: 'Owner', avatarUrl: 'https://av/new' })
    expect(refreshed?.avatarUrl).toBe('https://av/new')
    expect((await s.findByEmail('own@akis.dev'))?.avatarUrl).toBe('https://av/new')
  })
  it('upsertOAuth returning identity with NO avatar PRESERVES the existing one', async () => {
    // A login whose profile exposes no picture must not wipe the avatar the account already had.
    const s = new UserStore()
    await s.upsertOAuth({ externalId: 'github:43', email: 'keep@akis.dev', name: 'Keep', avatarUrl: 'https://av/keep' })
    const refreshed = await s.upsertOAuth({ externalId: 'github:43', email: 'keep@akis.dev', name: 'Keep' }) // no avatar this time
    expect(refreshed?.avatarUrl).toBe('https://av/keep')
    expect((await s.findByEmail('keep@akis.dev'))?.avatarUrl).toBe('https://av/keep')
  })
  it('upsertOAuth returns an email account ALREADY bound to identity A unchanged when a DIFFERENT identity B logs in with that email (Pg parity)', async () => {
    // Parity with PgUserStore (`if (byEmail.externalId) return byEmail`): once an email is bound
    // to one provider identity, a second provider that happens to share the verified email must NOT
    // rebind the externalId NOR adopt its avatar onto the first provider's account — the account is
    // returned with NO mutation. (Without this, identity B's avatar would land on identity A.)
    const s = new UserStore()
    // identity A links/creates the account (no avatar yet, so a clobber would be visible).
    const a = await s.upsertOAuth({ externalId: 'github:100', email: 'shared@akis.dev', name: 'Shared' })
    expect(a?.externalId).toBe('github:100')
    expect(a?.avatarUrl).toBeUndefined()
    // identity B logs in with the SAME email, carrying an avatar.
    const b = await s.upsertOAuth({ externalId: 'google:200', email: 'shared@akis.dev', name: 'Shared', avatarUrl: 'https://av/B' })
    // Same row, still bound to A, and B's avatar was NOT adopted.
    expect(b?.id).toBe(a?.id)
    expect(b?.externalId).toBe('github:100')
    expect(b?.avatarUrl).toBeUndefined()
    // The cross-index for B's identity was never created (no rebind), so A still owns the email.
    expect((await s.findByEmail('shared@akis.dev'))?.externalId).toBe('github:100')
    expect((await s.findByEmail('shared@akis.dev'))?.avatarUrl).toBeUndefined()
  })
  it('upsertOAuth adopts an avatar on link only when absent, and never clobbers an existing one', async () => {
    const s = new UserStore()
    // (a) link path adopts the avatar when the account has none.
    const pw = await s.create({ name: 'No Pic', email: 'link@akis.dev', passwordHash: 'h' })
    await s.upsertOAuth({ externalId: 'github:6', email: 'link@akis.dev', name: 'No Pic', avatarUrl: 'https://av/6' })
    expect((await s.findById(pw.id))?.avatarUrl).toBe('https://av/6')
    // (b) the SAME identity re-logging in is the returning-identity path: a fresh provider
    //     avatar refreshes the stored picture (so an owner's updated photo follows them).
    await s.upsertOAuth({ externalId: 'github:6', email: 'link@akis.dev', name: 'No Pic', avatarUrl: 'https://av/UPDATED' })
    expect((await s.findById(pw.id))?.avatarUrl).toBe('https://av/UPDATED')
  })
})
