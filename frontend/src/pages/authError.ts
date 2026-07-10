import { ApiError } from '../api/client.js'
import type { StringKey } from '../i18n/catalog.js'

/**
 * Map a backend auth error's machine code to a catalog key (B6-i). The backend has no locale
 * awareness — its `error` message text is always English — but every auth failure carries a
 * stable `code` (auth.routes.ts), so the FE owns the user-facing wording. Same idiom as
 * Login's OAUTH_ERROR_KEYS: an unknown/absent code falls back to the generic key, so a raw
 * English transport string never reaches a TR session.
 */
const AUTH_ERROR_KEYS: Record<string, StringKey> = {
  BadCredentials: 'auth.err.badCredentials',
  WeakPassword: 'auth.pwTooShort', // reuse the FE's existing password-length copy
  BadRequest: 'auth.err.badRequest',
  EmailTaken: 'auth.err.emailTaken',
  BadToken: 'auth.err.badToken',
  Unauthorized: 'auth.err.unauthorized',
  RateLimited: 'auth.err.rateLimited',
  SignupDisabled: 'auth.signup.disabled', // existing key — keeps Signup's 403 behavior
}

/** Resolve any thrown value from an auth call to a translatable catalog key. */
export function authErrorKey(e: unknown): StringKey {
  if (ApiError.is(e) && e.code !== undefined) {
    const key = AUTH_ERROR_KEYS[e.code]
    if (key) return key
  }
  return 'auth.err.generic'
}
