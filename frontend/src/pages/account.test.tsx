import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiClient } from '../api/client.js'
import { AccountSettings } from './AccountSettings.js'
import { AuthProvider } from '../auth/AuthContext.js'
import { I18nProvider } from '../i18n/I18nContext.js'

function fakeApi(handlers: Record<string, () => unknown>) {
  const fetchFn = vi.fn(async (path: string, init?: RequestInit) => {
    const key = Object.keys(handlers).find(k => path.endsWith(k) && (k !== '/auth/me' || (init?.method ?? 'GET') === 'GET'))
    return { ok: true, status: 200, json: async () => (key ? handlers[key]!() : {}) } as unknown as Response
  })
  return { api: new ApiClient('', fetchFn), fetchFn }
}

const wrap = (api: ApiClient) =>
  render(<I18nProvider><AuthProvider api={api}><AccountSettings api={api} /></AuthProvider></I18nProvider>)

describe('AccountSettings', () => {
  it('saves a new display name', async () => {
    const { api, fetchFn } = fakeApi({ '/auth/me': () => ({ user: { id: '1', name: 'Ada', email: 'a@b.com' } }) })
    wrap(api)
    await waitFor(() => expect((screen.getByLabelText('Display name') as HTMLInputElement).value).toBe('Ada'))
    await userEvent.clear(screen.getByLabelText('Display name'))
    await userEvent.type(screen.getByLabelText('Display name'), 'Ada Lovelace')
    await userEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    await waitFor(() => expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('/auth/me'), expect.objectContaining({ method: 'PATCH' })))
  })

  it('changes the password', async () => {
    const { api, fetchFn } = fakeApi({ '/auth/me': () => ({ user: { id: '1', name: 'Ada', email: 'a@b.com' } }), '/auth/change-password': () => ({ ok: true }) })
    wrap(api)
    await userEvent.type(screen.getByLabelText('Current password'), 'oldpassword1')
    await userEvent.type(screen.getByLabelText('New password'), 'newpassword9')
    await userEvent.click(screen.getByRole('button', { name: /Update password/i }))
    await waitFor(() => expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('/auth/change-password'), expect.objectContaining({ method: 'POST' })))
    expect(await screen.findByText(/Password updated/)).toBeInTheDocument()
  })
})
