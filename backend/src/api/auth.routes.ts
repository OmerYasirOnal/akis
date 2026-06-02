import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { UserStore, EmailTakenError, toPublic, type PublicUser } from '../auth/UserStore.js'
import { hashPassword, verifyPassword } from '../auth/password.js'
import { signJwt, verifyJwt, JwtError } from '../auth/jwt.js'
import { serializeCookie, parseCookies, type CookieConfig } from '../auth/cookie.js'

export interface AuthDeps {
  users: UserStore
  /** HS256 signing secret (AUTH_JWT_SECRET). */
  secret: string
  cookie: CookieConfig
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
  const token = signJwt({ sub: user.id, email: user.email, name: user.name }, deps.secret, Math.floor(deps.cookie.maxAgeMs / 1000))
  reply.header('set-cookie', serializeCookie(deps.cookie.name, token, { ...deps.cookie, httpOnly: true }))
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps): void {
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

  app.post('/auth/logout', async (_req, reply) => {
    // Expire the cookie (Max-Age 0) with the same attributes so it actually clears.
    reply.header('set-cookie', serializeCookie(deps.cookie.name, '', { ...deps.cookie, maxAgeMs: 0, httpOnly: true }))
    return reply.send({ ok: true })
  })
}
