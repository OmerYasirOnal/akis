import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { App } from './App.js'

/**
 * GLOBAL a11y structure (studio-preview-drawer a11y pass) — these guard the authed AppFrame's
 * landmark/heading scaffolding so a refactor can't silently drop them:
 *  - the active primary-nav link carries aria-current="page", inactive ones do NOT;
 *  - a skip-to-content link + a single <main id="main"> landmark exist;
 *  - document.title reflects the current route (`<route> · AKIS`).
 *
 * Like App.account-menu.test.tsx, App builds its OWN ApiClient(BASE) with the real fetch, so we
 * stub globalThis.fetch: GET /auth/me → an authed user (so we reach AppFrame), everything else a
 * benign empty-JSON 200 so the routed page never crashes.
 */

const ME = '/auth/me'

function stubFetch(): ReturnType<typeof vi.fn> {
  return vi.fn((input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.endsWith(ME)) {
      return Promise.resolve(new Response(JSON.stringify({ user: authedUser }), { status: 200, headers: { 'content-type': 'application/json' } }))
    }
    return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
  })
}

const authedUser = { id: 'u1', name: 'Ada Lovelace', email: 'ada@example.com', provider: 'github' as const }

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('fetch', stubFetch())
})
afterEach(() => { vi.restoreAllMocks() })

describe('App a11y: primary-nav aria-current', () => {
  it('marks ONLY the active route link with aria-current="page"', async () => {
    window.history.pushState({}, '', '/history') // History is the active route
    render(<App />)
    // The primary nav is named so we can scope to it (and not the Landing/Docs nav).
    const nav = await screen.findByRole('navigation', { name: 'Primary' })
    const history = within(nav).getByRole('link', { name: 'History' })
    const studio = within(nav).getByRole('link', { name: 'Studio' })
    expect(history).toHaveAttribute('aria-current', 'page')
    expect(studio).not.toHaveAttribute('aria-current')
  })
})

describe('App brand: clean wordmark (no tagline)', () => {
  it('the top-nav brand link reads only "AKIS" — no "· agentic build studio" tagline or dot', async () => {
    window.history.pushState({}, '', '/')
    render(<App />)
    await screen.findByRole('navigation', { name: 'Primary' })
    // The brand is the home link; its accessible name is the visible wordmark, which must be
    // exactly "AKIS" — the tagline and the "·" separator were removed (owner feedback).
    const brand = screen.getByRole('link', { name: 'AKIS' })
    expect(brand).toHaveAttribute('href', '/')
    expect(brand.textContent).toBe('AKIS')
    expect(brand.textContent).not.toMatch(/studio|stüdyo|·/i)
  })
})

describe('App a11y: skip link + main landmark', () => {
  it('renders a skip-to-content link targeting #main and a single <main id="main">', async () => {
    window.history.pushState({}, '', '/settings')
    const { container } = render(<App />)
    await screen.findByRole('navigation', { name: 'Primary' })
    const skip = screen.getByRole('link', { name: 'Skip to content' })
    expect(skip).toHaveAttribute('href', '#main')
    const mains = container.querySelectorAll('main#main')
    expect(mains.length).toBe(1) // exactly one main landmark per view
  })

  it('renders exactly one sr-only <h1> for a non-/docs authed route (/analytics)', async () => {
    window.history.pushState({}, '', '/analytics')
    render(<App />)
    await screen.findByRole('navigation', { name: 'Primary' })
    const h1s = screen.getAllByRole('heading', { level: 1 })
    expect(h1s.length).toBe(1)
    expect(h1s[0]).toHaveTextContent('Analytics')
  })

  it('renders exactly one <h1> on authed /docs — DocsPage\'s own visible h1, NOT a second sr-only one', async () => {
    // Regression guard: AppFrame used to inject a sr-only <h1> for every authed route including
    // /docs; DocsPage already renders a prominent hero <h1>, producing two h1s on the same view.
    // With the OWNS_OWN_H1 guard the AppFrame sr-only h1 is suppressed for /docs.
    window.history.pushState({}, '', '/docs')
    render(<App />)
    await screen.findByRole('navigation', { name: 'Primary' })
    // DocsPage is lazy — wait until its content resolves (Suspense fallback clears).
    await waitFor(() => {
      const h1s = screen.getAllByRole('heading', { level: 1 })
      expect(h1s.length).toBe(1)
    })
  })
})

describe('App a11y: per-route document.title', () => {
  it('sets document.title to "<route> · AKIS" for the active route', async () => {
    window.history.pushState({}, '', '/workflows')
    render(<App />)
    await waitFor(() => expect(document.title).toBe('Workflows · AKIS'))
  })

  it('falls back to the app name title for an unknown authed path', async () => {
    // An unmapped path renders <Navigate to="/"> but the frame title still resolves via the
    // app.title fallback before/at that render.
    window.history.pushState({}, '', '/totally-unknown')
    render(<App />)
    await waitFor(() => expect(document.title).toContain('· AKIS'))
  })
})
