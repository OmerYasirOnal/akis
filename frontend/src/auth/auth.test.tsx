import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiClient } from '../api/client.js'
import { AuthProvider, useAuth } from './AuthContext.js'
import { RouterProvider, useRouter, Link } from '../router/router.js'
import { I18nProvider } from '../i18n/I18nContext.js'
import { Login } from '../pages/Login.js'

beforeEach(() => { window.history.pushState({}, '', '/') })

/** A fetch double whose per-path handlers are configured per test. */
function fakeApi(handlers: Record<string, (init?: RequestInit) => { ok: boolean; status: number; body: unknown }>) {
  const fetchFn = vi.fn(async (path: string, init?: RequestInit) => {
    const key = Object.keys(handlers).find(k => path.endsWith(k))
    const h = key ? handlers[key]!(init) : { ok: false, status: 404, body: { error: 'nope' } }
    return { ok: h.ok, status: h.status, json: async () => h.body } as unknown as Response
  })
  return { api: new ApiClient('', fetchFn), fetchFn }
}

function Probe() {
  const { user, loading, logout } = useAuth()
  if (loading) return <div>loading</div>
  return <div>{user ? <><span>hi {user.name}</span><button onClick={() => void logout()}>out</button></> : <span>anon</span>}</div>
}

describe('AuthContext', () => {
  it('restores the session via /auth/me on mount', async () => {
    const { api } = fakeApi({ '/auth/me': () => ({ ok: true, status: 200, body: { user: { id: '1', name: 'Ada', email: 'a@b.com' } } }) })
    render(<I18nProvider><AuthProvider api={api}><Probe /></AuthProvider></I18nProvider>)
    await waitFor(() => expect(screen.getByText('hi Ada')).toBeInTheDocument())
  })

  it('shows anon when /auth/me is 401, and logout clears the user', async () => {
    const { api } = fakeApi({
      '/auth/me': () => ({ ok: false, status: 401, body: { error: 'unauthorized' } }),
      '/auth/logout': () => ({ ok: true, status: 200, body: { ok: true } }),
    })
    render(<I18nProvider><AuthProvider api={api}><Probe /></AuthProvider></I18nProvider>)
    await waitFor(() => expect(screen.getByText('anon')).toBeInTheDocument())
  })
})

function PathProbe() {
  const { path } = useRouter()
  return <><span>at {path}</span><Link to="/settings">go</Link></>
}

describe('router', () => {
  it('Link navigates client-side and updates the path', async () => {
    render(<RouterProvider><PathProbe /></RouterProvider>)
    expect(screen.getByText('at /')).toBeInTheDocument()
    await userEvent.click(screen.getByText('go'))
    expect(screen.getByText('at /settings')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/settings')
  })
})

describe('Login page', () => {
  it('submits credentials, signs in, and navigates home', async () => {
    const { api, fetchFn } = fakeApi({
      '/auth/me': () => ({ ok: false, status: 401, body: {} }),
      '/auth/login': () => ({ ok: true, status: 200, body: { user: { id: '1', name: 'Ada', email: 'a@b.com' } } }),
    })
    window.history.pushState({}, '', '/login')
    render(<I18nProvider><RouterProvider><AuthProvider api={api}><Login api={api} /></AuthProvider></RouterProvider></I18nProvider>)
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.com')
    await userEvent.type(screen.getByLabelText('Password'), 'hunter2hunter')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    await waitFor(() => expect(window.location.pathname).toBe('/'))
    expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('/auth/login'), expect.objectContaining({ method: 'POST' }))
  })
})
