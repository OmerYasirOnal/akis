import type { FastifyReply } from 'fastify'
import { signJwt } from './jwt.js'
import { serializeCookie, type CookieConfig } from './cookie.js'
import type { PublicUser } from './UserStore.js'

/** Mint a session JWT for a user and set it as the httpOnly session cookie. Shared by
 *  the password and OAuth login paths so cookie semantics stay identical. */
export function setSessionCookie(reply: FastifyReply, user: PublicUser, secret: string, cookie: CookieConfig, tokenVersion = 0): void {
  // `tv` (token version) enables REVOCATION: verification compares it to the user record,
  // so bumping the record (password change / logout-all) kills every outstanding session.
  const token = signJwt({ sub: user.id, email: user.email, name: user.name, tv: tokenVersion }, secret, Math.floor(cookie.maxAgeMs / 1000))
  reply.header('set-cookie', serializeCookie(cookie.name, token, { ...cookie, httpOnly: true }))
}
