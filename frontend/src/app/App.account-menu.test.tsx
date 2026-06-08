import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { App } from './App.js'

/**
 * FR-account-menu-2 — the AccountMenu trigger appears ONLY for an authenticated user.
 *
 * This guards the composition in App's AppFrame (`{user && <AccountMenu .../>}`) plus the
 * upstream gate in Shell (an anonymous visitor never reaches AppFrame at all — they get the
 * public Landing, which has no account menu). A regression that rendered the menu unconditionally
 * (leaking it to logged-out visitors) or dropped it for authed users would FAIL one of these.
 *
 * App builds its OWN ApiClient(BASE) with the real `fetch`, so we stub globalThis.fetch:
 *  - GET /auth/me decides the auth state (200 {user} = signed in, 401 = anonymous).
 *  - every other request gets a benign empty-JSON 200 so the frame/route never crashes.
 */

const ME = '/auth/me'

function stubFetch(me: { status: number; user?: unknown }) {
  return vi.fn((input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.endsWith(ME)) {
      const body = me.user ? JSON.stringify({ user: me.user }) : JSON.stringify({ error: 'unauthorized' })
      return Promise.resolve(new Response(body, { status: me.status, headers: { 'content-type': 'application/json' } }))
    }
    // OAuth providers must be a well-formed {providers:[]} (OAuthButtons reads .providers).
    if (url.endsWith('/oauth/providers')) {
      return Promise.resolve(new Response(JSON.stringify({ providers: [] }), { status: 200, headers: { 'content-type': 'application/json' } }))
    }
    // Benign default for everything else (health, docs assets, …).
    return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
  })
}

const authedUser = { id: 'u1', name: 'Ada Lovelace', email: 'ada@example.com', provider: 'github' as const }

beforeEach(() => {
  window.history.pushState({}, '', '/docs') // authed → DocsPage (light route); anon → public docs/landing
  localStorage.clear()
})
afterEach(() => { vi.restoreAllMocks() })

describe('App: AccountMenu visibility is gated on the authenticated user (FR-account-menu-2)', () => {
  it('renders NO "Account menu" trigger for an anonymous visitor (401 on /auth/me)', async () => {
    vi.stubGlobal('fetch', stubFetch({ status: 401 }))
    render(<App />)
    // Wait until the auth probe RESOLVES to the anonymous public frame (the /docs "Sign in"
    // link only renders once Shell has settled to !user) — so the absence below is a real
    // gate result, not just an unresolved-pending render.
    await waitFor(() => expect(screen.getByRole('link', { name: 'Sign in' })).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Account menu' })).toBeNull()
  })

  it('renders the "Account menu" trigger once /auth/me returns a user', async () => {
    vi.stubGlobal('fetch', stubFetch({ status: 200, user: authedUser }))
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Account menu' })).toBeInTheDocument())
  })
})

describe('App: a language toggle is available BEFORE auth (pre-auth switcher)', () => {
  it('anonymous /login shows the language toggle and clicking it flips EN→TR in place', async () => {
    window.history.pushState({}, '', '/login')
    vi.stubGlobal('fetch', stubFetch({ status: 401 }))
    render(<App />)
    const toggle = await screen.findByRole('button', { name: /switch language/i })
    expect(toggle).toHaveTextContent('EN')
    fireEvent.click(toggle) // same DOM node persists; React updates its label in place
    expect(toggle).toHaveTextContent('TR')
  })
})
