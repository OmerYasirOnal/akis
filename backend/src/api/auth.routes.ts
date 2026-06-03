import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { EmailTakenError, toPublic, type PublicUser, type UserStorePort } from '../auth/UserStore.js'
import { hashPassword, verifyPassword } from '../auth/password.js'
import { verifyJwt, signResetToken, verifyResetToken } from '../auth/jwt.js'
import { serializeCookie, parseCookies, type CookieConfig } from '../auth/cookie.js'
import { setSessionCookie } from '../auth/session.js'
import { NoopMailer, type Mailer } from '../mail/Mailer.js'

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
 *  Exported so other protected routes can guard with the same logic. */
export function userIdFromRequest(req: FastifyRequest, deps: AuthDeps): string {
  const token = parseCookies(req.headers.cookie)[deps.cookie.name]
  if (!token) throw new UnauthorizedError()
  try { return verifyJwt(token, deps.secret).sub } catch { throw new UnauthorizedError() }
}

function setSession(reply: FastifyReply, user: PublicUser, deps: AuthDeps): void {
  setSessionCookie(reply, user, deps.secret, deps.cookie)
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps): void {
  // A "real" mailer (SMTP) is configured ⇒ email the reset link AND suppress the dev-echo.
  // The NoopMailer default (and an absent mailer) keep today's dev-echo behavior exactly.
  const mailEnabled = deps.mailer !== undefined && !(deps.mailer instanceof NoopMailer)
  app.post<{ Body: { name?: unknown; email?: unknown; password?: unknown } }>('/auth/signup', async (req, reply) => {
    const name = isStr(req.body?.name) ? req.body.name.trim() : ''
    const email = isStr(req.body?.email) ? req.body.email.trim() : ''
    const password = isStr(req.body?.password) ? req.body.password : ''
    if (!name) return reply.code(400).send({ error: 'name required', code: 'BadRequest' })
    if (!EMAIL_RE.test(email)) return reply.code(400).send({ error: 'valid email required', code: 'BadRequest' })
    if (password.length < 8) return reply.code(400).send({ error: 'password must be at least 8 characters', code: 'WeakPassword' })
    try {
      const user = await deps.users.create({ name, email, passwordHash: await hashPassword(password) })
      setSession(reply, toPublic(user), deps)
      return reply.code(201).send({ user: toPublic(user) })
    } catch (err) {
      if (err instanceof EmailTakenError) return reply.code(409).send({ error: err.message, code: 'EmailTaken' })
      throw err
    }
  })

  app.post<{ Body: { email?: unknown; password?: unknown } }>('/auth/login', async (req, reply) => {
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
    setSession(reply, toPublic(user), deps)
    return reply.send({ user: toPublic(user) })
  })

  app.get('/auth/me', async (req, reply) => {
    let id: string
    try { id = userIdFromRequest(req, deps) } catch { return reply.code(401).send({ error: 'unauthorized', code: 'Unauthorized' }) }
    const user = await deps.users.findById(id)
    if (!user) return reply.code(401).send({ error: 'unauthorized', code: 'Unauthorized' })
    return reply.send({ user: toPublic(user) })
  })

  app.patch<{ Body: { name?: unknown } }>('/auth/me', async (req, reply) => {
    let id: string
    try { id = userIdFromRequest(req, deps) } catch { return reply.code(401).send({ error: 'unauthorized', code: 'Unauthorized' }) }
    const name = isStr(req.body?.name) ? req.body.name.trim() : ''
    if (!name) return reply.code(400).send({ error: 'name required', code: 'BadRequest' })
    const user = await deps.users.updateName(id, name)
    if (!user) return reply.code(401).send({ error: 'unauthorized', code: 'Unauthorized' })
    return reply.send({ user: toPublic(user) })
  })

  app.post<{ Body: { currentPassword?: unknown; newPassword?: unknown } }>('/auth/change-password', async (req, reply) => {
    let id: string
    try { id = userIdFromRequest(req, deps) } catch { return reply.code(401).send({ error: 'unauthorized', code: 'Unauthorized' }) }
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
    return reply.send({ ok: true })
  })

  app.post('/auth/logout', async (_req, reply) => {
    // Expire the cookie (Max-Age 0) with the same attributes so it actually clears.
    reply.header('set-cookie', serializeCookie(deps.cookie.name, '', { ...deps.cookie, maxAgeMs: 0, httpOnly: true }))
    return reply.send({ ok: true })
  })

  app.post<{ Body: { email?: unknown } }>('/auth/forgot-password', async (req, reply) => {
    const email = isStr(req.body?.email) ? req.body.email.trim() : ''
    // Always the SAME generic response whether or not the email exists (no enumeration).
    const generic: Record<string, unknown> = { message: 'If that email has an account, a reset link has been sent.' }
    if (!EMAIL_RE.test(email)) return reply.send(generic)
    const user = await deps.users.findByEmail(email)
    if (user) {
      const token = signResetToken(user.id, deps.secret) // 15-min, purpose-scoped
      const path = `/reset-password?token=${encodeURIComponent(token)}`
      // Deliver the link by email when a real mailer is configured (P5-OPS-1). The send is
      // best-effort: a mail failure is SWALLOWED so the response stays byte-identical
      // whether or not delivery succeeded (no enumeration via a 500 or a slow path).
      // The token/link is NEVER logged on this path.
      if (mailEnabled) {
        const resetUrl = deps.publicBaseUrl ? `${deps.publicBaseUrl}${path}` : path
        try { await deps.mailer!.sendResetLink({ to: user.email, resetUrl }) } catch { /* swallow: mail outage must not leak */ }
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
    setSession(reply, toPublic(user), deps) // reset succeeds → sign the user in
    return reply.send({ user: toPublic(user) })
  })
}
