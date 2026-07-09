import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiClient, ApiError } from '../api/client.js'
import { authErrorKey } from './authError.js'
import { Login } from './Login.js'
import { AuthProvider } from '../auth/AuthContext.js'
import { I18nProvider } from '../i18n/I18nContext.js'
import { RouterProvider } from '../router/router.js'

describe('authErrorKey (pure code → catalog-key mapping, B6-i)', () => {
  it('maps every stable backend auth code to a catalog key', () => {
    expect(authErrorKey(new ApiError(401, 'invalid email or password', 'BadCredentials'))).toBe('auth.err.badCredentials')
    expect(authErrorKey(new ApiError(400, 'password must be at least 8 characters', 'WeakPassword'))).toBe('auth.pwTooShort')
    expect(authErrorKey(new ApiError(400, 'name required', 'BadRequest'))).toBe('auth.err.badRequest')
    expect(authErrorKey(new ApiError(409, 'email already registered', 'EmailTaken'))).toBe('auth.err.emailTaken')
    expect(authErrorKey(new ApiError(400, 'invalid or expired reset link', 'BadToken'))).toBe('auth.err.badToken')
    expect(authErrorKey(new ApiError(401, 'unauthorized', 'Unauthorized'))).toBe('auth.err.unauthorized')
    expect(authErrorKey(new ApiError(429, 'too many attempts — try again later', 'RateLimited'))).toBe('auth.err.rateLimited')
    expect(authErrorKey(new ApiError(403, 'registration is disabled on this instance', 'SignupDisabled'))).toBe('auth.signup.disabled')
  })

  it('an unknown code, a code-less ApiError, and a non-ApiError all fall back to the generic key — never the raw message', () => {
    expect(authErrorKey(new ApiError(500, 'kaboom', 'SomethingNew'))).toBe('auth.err.generic')
    expect(authErrorKey(new ApiError(500, 'kaboom'))).toBe('auth.err.generic')
    expect(authErrorKey(new Error('TypeError: fetch failed'))).toBe('auth.err.generic')
  })
})

/** Non-ok responses carry {error, code} — ApiClient turns them into a coded ApiError (client.ts json()). */
function failingApi(status: number, error: string, code: string): ApiClient {
  const fetchFn = vi.fn(async (path: string) => {
    if (path.endsWith('/auth/me')) return { ok: true, status: 200, json: async () => ({ user: null }) } as unknown as Response
    return { ok: false, status, json: async () => ({ error, code }) } as unknown as Response
  })
  return new ApiClient('', fetchFn)
}

const wrap = (ui: React.ReactElement, api: ApiClient) =>
  render(<I18nProvider><RouterProvider><AuthProvider api={api}>{ui}</AuthProvider></RouterProvider></I18nProvider>)

beforeEach(() => { window.history.pushState({}, '', '/') })

describe('Login — localized API errors (B6-i)', () => {
  it('a failed sign-in renders the catalog copy, never the backend’s raw English transport string', async () => {
    const api = failingApi(401, 'invalid email or password', 'BadCredentials')
    wrap(<Login api={api} />, api)
    await userEvent.type(screen.getByLabelText('Email'), 'ada@akis.dev')
    await userEvent.type(screen.getByLabelText('Password'), 'wrong-pass-1')
    await userEvent.click(screen.getByRole('button', { name: /Sign in/i }))
    // The catalog copy (EN default locale in tests) — not the backend's raw lowercase message.
    await waitFor(() => expect(screen.getByText('Invalid email or password.')).toBeInTheDocument())
    expect(screen.queryByText('invalid email or password')).toBeNull()
  })
})
