import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiClient } from '../api/client.js'
import { ForgotPassword } from './ForgotPassword.js'
import { ResetPassword } from './ResetPassword.js'
import { AuthProvider } from '../auth/AuthContext.js'
import { I18nProvider } from '../i18n/I18nContext.js'
import { RouterProvider } from '../router/router.js'

function fakeApi(handlers: Record<string, () => unknown>) {
  const fetchFn = vi.fn(async (path: string) => {
    const key = Object.keys(handlers).find(k => path.endsWith(k))
    return { ok: true, status: 200, json: async () => (key ? handlers[key]!() : {}) } as unknown as Response
  })
  return new ApiClient('', fetchFn)
}

const wrap = (ui: React.ReactElement, api: ApiClient) =>
  render(<I18nProvider><RouterProvider><AuthProvider api={api}>{ui}</AuthProvider></RouterProvider></I18nProvider>)

beforeEach(() => { window.history.pushState({}, '', '/') })

describe('ForgotPassword', () => {
  it('submits the email and shows the sent message (+ dev link)', async () => {
    const api = fakeApi({ '/auth/me': () => ({ user: null }), '/auth/forgot-password': () => ({ message: 'sent', resetUrl: '/reset-password?token=abc' }) })
    wrap(<ForgotPassword api={api} />, api)
    await userEvent.type(screen.getByLabelText('Email'), 'ada@akis.dev')
    await userEvent.click(screen.getByRole('button', { name: /Send reset link/i }))
    await waitFor(() => expect(screen.getByText(/reset link is on its way/i)).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /Dev: open reset link/i })).toBeInTheDocument()
  })
})

describe('ResetPassword', () => {
  it('with a token, sets a new password and navigates home', async () => {
    window.history.pushState({}, '', '/reset-password?token=abc')
    const api = fakeApi({ '/auth/reset-password': () => ({ user: { id: '1', name: 'Ada', email: 'a@b.com' } }), '/auth/me': () => ({ user: { id: '1', name: 'Ada', email: 'a@b.com' } }) })
    wrap(<ResetPassword api={api} />, api)
    await userEvent.type(screen.getByLabelText('Password'), 'brandnewpass9')
    await userEvent.click(screen.getByRole('button', { name: /Set new password/i }))
    await waitFor(() => expect(window.location.pathname).toBe('/'))
  })
  it('without a token shows an invalid-link message', () => {
    window.history.pushState({}, '', '/reset-password')
    const api = fakeApi({ '/auth/me': () => ({ user: null }) })
    wrap(<ResetPassword api={api} />, api)
    expect(screen.getByText(/missing or invalid/i)).toBeInTheDocument()
  })
})
