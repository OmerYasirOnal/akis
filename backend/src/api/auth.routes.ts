import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { EmailTakenError, toPublic, type AuthUser, type UserStorePort } from '../auth/UserStore.js'
import { hashPassword, verifyPassword } from '../auth/password.js'
import { verifyJwt, signResetToken, verifyResetToken } from '../auth/jwt.js'
import { serializeCookie, parseCookies, type CookieConfig } from '../auth/cookie.js'
import { setSessionCookie } from '../auth/session.js'
import { NoopMailer, type Mailer } from '../mail/Mailer.js'
import { createRateLimiter, type RateLimiter } from '../auth/rateLimit.js'

export interface AuthDeps {
  users: UserStorePort
  /** HS256 signing secret (AUTH_JWT_SECRET). */
  secret: string
  cookie: CookieConfig
  /** Dev convenience: echo the password-reset token/link in the response (no email
   *  service). MUST be false in production (would leak a reset capability). */
  devEcho?: boolean
  /** Optional mailer seam (P5-OPS-1). When a real (SMTP) mailer is configured the reset
   *  LINK is emailed and the dev-echo is suppressed. Absent / NoopMailer ⇒ today's
   *  dev-echo behavior is preserved exactly. */
  mailer?: Mailer
  /** Absolute browser origin (PUBLIC_BASE_URL) used to build the emailed reset link.
   *  When unset the link stays a relative path (today's dev-echo shape). */
  publicBaseUrl?: string
  /** Injectable per-route limiters (tests). Defaults are created inside registerAuthRoutes. */
  rateLimits?: { login?: RateLimiter; signup?: RateLimiter; forgot?: RateLimiter }
}

export class UnauthorizedError extends Error { constructor() { super('unauthorized'); this.name = 'UnauthorizedError' } }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const isStr = (v: unknown): v is string => typeof v === 'string'

// A fixed dummy hash so the unknown-email login path still runs one scrypt compare —
// closing the timing side channel that would otherwise reveal which emails exist.
// Computed once, lazily (so importing this module costs nothing).
let dummyHashP: Promise<string> | undefined
const dummyHash = (): Promise<string> => (dummyHashP ??= hashPassword('timing-equalizer-not-a-real-password'))

/** Resolve the authenticated user id from the session cookie, or throw Unauthorized.
 *  Exported so other protected routes can guard with the same logic. ASYNC since the
 *  REVOCATION check (audit gap): the JWT's `tv` claim must match the user record's
 *  tokenVersion — a bump (password change / logout-all) kills every outstanding token. */
export async function userIdFromRequest(req: FastifyRequest, deps: AuthDeps): Promise<string> {
  const token = parseCookies(req.headers.cookie)[deps.cookie.name]
  if (!token) throw new UnauthorizedError()
  let claims
  try { claims = verifyJwt(token, deps.secret) } catch { throw new UnauthorizedError() }
  const user = await deps.users.findById(claims.sub)
  if (!user || (claims.tv ?? 0) !== (user.tokenVersion ?? 0)) throw new UnauthorizedError()
  return claims.sub
}

function setSession(reply: FastifyReply, user: AuthUser, deps: AuthDeps): void {
  setSessionCookie(reply, toPublic(user), deps.secret, deps.cookie, user.tokenVersion ?? 0)
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps): void {
  // A "real" mailer (SMTP) is configured ⇒ email the reset link AND suppress the dev-echo.
  // The NoopMailer default (and an absent mailer) keep today's dev-echo behavior exactly.
  const mailEnabled = deps.mailer !== undefined && !(deps.mailer instanceof NoopMailer)
  // RATE LIMITS (audit gap): per-IP sliding windows on the brute-force surfaces. Login is
  // the scrypt-amplified credential-stuffing target; signup/forgot are abuse surfaces.
  const limits = {
    login: deps.rateLimits?.login ?? createRateLimiter({ max: 10, windowMs: 5 * 60_000 }),
    signup: deps.rateLimits?.signup ?? createRateLimiter({ max: 5, windowMs: 10 * 60_000 }),
    forgot: deps.rateLimits?.forgot ?? createRateLimiter({ max: 5, windowMs: 15 * 60_000 }),
  }
  const overLimit = (limiter: RateLimiter, req: FastifyRequest, reply: FastifyReply): boolean => {
    const retry = limiter.hit(req.ip || 'unknown')
    if (retry === undefined) return false
    void reply.header('retry-after', String(retry)).code(429).send({ error: 'too many attempts — try again later', code: 'RateLimited' })
    return true
  }
  app.post<{ Body: { name?: unknown; email?: unknown; password?: unknown } }>('/auth/signup', async (req, reply) => {
    if (overLimit(limits.signup, req, reply)) return
    const name = isStr(req.body?.name) ? req.body.name.trim() : ''
    const email = isStr(req.body?.email) ? req.body.email.trim() : ''
    const password = isStr(req.body?.password) ? req.body.password : ''
    if (!name) return reply.code(400).send({ error: 'name required', code: 'BadRequest' })
    if (!EMAIL_RE.test(email)) return reply.code(400).send({ error: 'valid email required', code: 'BadRequest' })
    if (password.length < 8) return reply.code(400).send({ error: 'password must be at least 8 characters', code: 'WeakPassword' })
    try {
      const user = await deps.users.create({ name, email, passwordHash: await hashPassword(password) })
      setSession(reply, user, deps)
      return reply.code(201).send({ user: toPublic(user) })
    } catch (err) {
      if (err instanceof EmailTakenError) return reply.code(409).send({ error: err.message, code: 'EmailTaken' })
      throw err
    }
  })

  app.post<{ Body: { email?: unknown; password?: unknown } }>('/auth/login', async (req, reply) => {
    if (overLimit(limits.login, req, reply)) return
    const email = isStr(req.body?.email) ? req.body.email.trim() : ''
    const password = isStr(req.body?.password) ? req.body.password : ''
    const user = await deps.users.findByEmail(email)
    // Same response AND same work for unknown-email and wrong-password: always run one
    // scrypt compare (against a dummy hash when the email is unknown) so neither the
    // body, the status, nor the response TIME reveals whether an account exists.
    const ok = await verifyPassword(password, user?.passwordHash ?? await dummyHash())
    if (!user || !ok) {
      return reply.code(401).send({ error: 'invalid email or password', code: 'BadCredentials' })
    }
    setSession(reply, user, deps)
    return reply.send({ user: toPublic(user) })
  })

  app.get('/auth/me', async (req, reply) => {
    let id: string
    try { id = await userIdFromRequest(req, deps) } catch { return reply.code(401).send({ error: 'unauthorized', code: 'Unauthorized' }) }
    const user = await deps.users.findById(id)
    if (!user) return reply.code(401).send({ error: 'unauthorized', code: 'Unauthorized' })
    return reply.send({ user: toPublic(user) })
  })

  app.patch<{ Body: { name?: unknown } }>('/auth/me', async (req, reply) => {
    let id: string
    try { id = await userIdFromRequest(req, deps) } catch { return reply.code(401).send({ error: 'unauthorized', code: 'Unauthorized' }) }
    const name = isStr(req.body?.name) ? req.body.name.trim() : ''
    if (!name) return reply.code(400).send({ error: 'name required', code: 'BadRequest' })
    const user = await deps.users.updateName(id, name)
    if (!user) return reply.code(401).send({ error: 'unauthorized', code: 'Unauthorized' })
    return reply.send({ user: toPublic(user) })
  })

  app.post<{ Body: { currentPassword?: unknown; newPassword?: unknown } }>('/auth/change-password', async (req, reply) => {
    let id: string
    try { id = await userIdFromRequest(req, deps) } catch { return reply.code(401).send({ error: 'unauthorized', code: 'Unauthorized' }) }
    const current = isStr(req.body?.currentPassword) ? req.body.currentPassword : ''
    const next = isStr(req.body?.newPassword) ? req.body.newPassword : ''
    if (next.length < 8) return reply.code(400).send({ error: 'password must be at least 8 characters', code: 'WeakPassword' })
    const user = await deps.users.findById(id)
    if (!user) return reply.code(401).send({ error: 'unauthorized', code: 'Unauthorized' })
    // OAuth-only accounts (empty hash) may SET a first password without a current one;
    // password accounts must prove the current password.
    if (user.passwordHash !== '' && !(await verifyPassword(current, user.passwordHash))) {
      return reply.code(400).send({ error: 'current password is incorrect', code: 'BadCredentials' })
    }
    await deps.users.updatePassword(user.id, await hashPassword(next))
    // REVOCATION: a password change kills every OTHER outstanding session (their JWTs carry
    // the old tv); this client gets a fresh cookie signed with the new version.
    await deps.users.bumpTokenVersion(user.id)
    const fresh = await deps.users.findById(user.id)
    if (fresh) setSession(reply, fresh, deps)
    return reply.send({ ok: true })
  })

  // Sign out EVERYWHERE: bump the token version (every outstanding JWT dies) + clear this cookie.
  app.post('/auth/logout-all', async (req, reply) => {
    let id: string
    try { id = await userIdFromRequest(req, deps) } catch { return reply.code(401).send({ error: 'unauthorized', code: 'Unauthorized' }) }
    await deps.users.bumpTokenVersion(id)
    reply.header('set-cookie', serializeCookie(deps.cookie.name, '', { ...deps.cookie, maxAgeMs: 0, httpOnly: true }))
    return reply.send({ ok: true })
  })

  app.post('/auth/logout', async (_req, reply) => {
    // Expire the cookie (Max-Age 0) with the same attributes so it actually clears.
    reply.header('set-cookie', serializeCookie(deps.cookie.name, '', { ...deps.cookie, maxAgeMs: 0, httpOnly: true }))
    return reply.send({ ok: true })
  })

  app.post<{ Body: { email?: unknown } }>('/auth/forgot-password', async (req, reply) => {
    if (overLimit(limits.forgot, req, reply)) return
    const email = isStr(req.body?.email) ? req.body.email.trim() : ''
    // Always the SAME generic response whether or not the email exists (no enumeration).
    const generic: Record<string, unknown> = { message: 'If that email has an account, a reset link has been sent.' }
    if (!EMAIL_RE.test(email)) return reply.send(generic)
    const user = await deps.users.findByEmail(email)
    if (user) {
      const token = signResetToken(user.id, deps.secret) // 15-min, purpose-scoped
      const path = `/reset-password?token=${encodeURIComponent(token)}`
      // Deliver the link by email when a real mailer is configured (P5-OPS-1). The send is
      // FIRE-AND-FORGET — it is intentionally NOT awaited: a mail failure OR a slow/hung relay
      // must not change the response latency, or that latency itself becomes an account-existence
      // oracle. The HTTP response returns at the same time regardless of whether the email exists
      // or whether delivery succeeds/slows. The token/link is NEVER logged on this path.
      if (mailEnabled) {
        const resetUrl = deps.publicBaseUrl ? `${deps.publicBaseUrl}${path}` : path
        void deps.mailer!.sendResetLink({ to: user.email, resetUrl }).catch(() => { /* swallow: mail outage must not leak */ })
      } else if (deps.devEcho) {
        // No mailer configured: keep today's DEV-only echo so the flow is usable. NEVER in prod.
        generic.resetToken = token
        generic.resetUrl = path
      }
    }
    return reply.send(generic)
  })

  app.post<{ Body: { token?: unknown; password?: unknown } }>('/auth/reset-password', async (req, reply) => {
    const token = isStr(req.body?.token) ? req.body.token : ''
    const password = isStr(req.body?.password) ? req.body.password : ''
    if (password.length < 8) return reply.code(400).send({ error: 'password must be at least 8 characters', code: 'WeakPassword' })
    let sub: string
    try { sub = verifyResetToken(token, deps.secret).sub } catch { return reply.code(400).send({ error: 'invalid or expired reset link', code: 'BadToken' }) }
    const user = await deps.users.findById(sub)
    if (!user) return reply.code(400).send({ error: 'invalid or expired reset link', code: 'BadToken' })
    await deps.users.updatePassword(user.id, await hashPassword(password))
    // REVOCATION: a reset proves account ownership — kill every outstanding session
    // (stolen cookies included); the fresh sign-in below carries the new version.
    await deps.users.bumpTokenVersion(user.id)
    const fresh = await deps.users.findById(user.id)
    setSession(reply, fresh ?? user, deps) // reset succeeds → sign the user in (with the NEW token version)
    return reply.send({ user: toPublic(user) })
  })
}
