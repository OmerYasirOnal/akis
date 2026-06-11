import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiClient, type GitHubConnectionStatus } from '../api/client.js'
import { GitHubConnection } from './GitHubConnection.js'
import { I18nProvider } from '../i18n/I18nContext.js'
import { STRINGS } from '../i18n/catalog.js'

/** A fake api whose githubStatus/disconnect are stubbable; the connect link uses the real
 *  ApiClient.githubConnectUrl (a pure string builder), so we read it off the live instance. */
function fakeApi(status: GitHubConnectionStatus, onDelete?: () => void) {
  const fetchFn = vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/auth/github/status')) return { ok: true, status: 200, json: async () => status } as unknown as Response
    if (path.endsWith('/auth/github') && (init?.method ?? 'GET') === 'DELETE') { onDelete?.(); return { ok: true, status: 200, json: async () => ({ removed: true }) } as unknown as Response }
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response
  })
  return { api: new ApiClient('', fetchFn), fetchFn }
}

const wrap = (api: ApiClient) => render(<I18nProvider><GitHubConnection api={api} /></I18nProvider>)

afterEach(() => {
  vi.restoreAllMocks()
  window.history.replaceState({}, '', '/')
})

describe('GitHubConnection', () => {
  it('shows a loading row while the first status fetch is in flight, then the content', async () => {
    // A deferred status response: the loading row must show until it resolves.
    let resolveStatus!: (s: GitHubConnectionStatus) => void
    const pending = new Promise<GitHubConnectionStatus>(r => { resolveStatus = r })
    const fetchFn = vi.fn(async (path: string) => {
      if (path.endsWith('/auth/github/status')) return { ok: true, status: 200, json: async () => pending } as unknown as Response
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response
    })
    wrap(new ApiClient('', fetchFn))
    expect(await screen.findByText(/Loading…/)).toBeInTheDocument()
    // Resolve → loading row gone, real content shown.
    resolveStatus({ connected: false, configured: false })
    expect(await screen.findByText(/not configured on this server/i)).toBeInTheDocument()
    expect(screen.queryByText(/Loading…/)).not.toBeInTheDocument()
  })

  it('configured:false renders the not-configured note with NO connect button', async () => {
    const { api } = fakeApi({ connected: false, configured: false })
    wrap(api)
    expect(await screen.findByText(/not configured on this server/i)).toBeInTheDocument()
    expect(screen.queryByText(/Connect GitHub/i)).not.toBeInTheDocument()
  })

  it('A2.1 — disconnected: NO repo input; a plain Connect link to the token-only flow + the disclosure', async () => {
    const { api } = fakeApi({ connected: false, configured: true })
    wrap(api)
    const link = (await screen.findByText(/Connect GitHub/i)).closest('a') as HTMLAnchorElement
    // Token-only connect: the href carries NO repo query.
    expect(link.getAttribute('href')).toBe('/auth/github/connect')
    expect(link.getAttribute('href')).not.toContain('repo=')
    // No repo input anymore.
    expect(screen.queryByLabelText(/Target repository/i)).toBeNull()
    // The standing disclosure: per-project PRIVATE repos in your personal account.
    expect(screen.getByText(/its own PRIVATE repo/i)).toBeInTheDocument()
  })

  it('A2.1 — the Connect link is always enabled (no client-side repo validation gate)', async () => {
    const { api } = fakeApi({ connected: false, configured: true })
    wrap(api)
    const link = (await screen.findByText(/Connect GitHub/i)).closest('a') as HTMLAnchorElement
    expect(link.getAttribute('aria-disabled')).toBeNull()
    expect(link.getAttribute('href')).toBe('/auth/github/connect')
  })

  it('A2.1 — connected renders the account login + the disclosure + a Disconnect button (NO repo row)', async () => {
    const { api } = fakeApi({ connected: true, configured: true, username: 'ada', scopes: ['repo'], connectedAt: new Date().toISOString() })
    wrap(api)
    expect(await screen.findByText('ada')).toBeInTheDocument()
    // No repo is shown anymore (per-project repos).
    expect(screen.queryByText('ada/app')).toBeNull()
    expect(screen.getByText(/its own PRIVATE repo/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Disconnect/i })).toBeInTheDocument()
  })

  it('Disconnect calls the API only after confirm', async () => {
    const onDelete = vi.fn()
    const { api } = fakeApi({ connected: true, configured: true, username: 'ada' }, onDelete)
    wrap(api)
    await screen.findByText('ada')

    // Cancelled confirm → no call.
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false)
    await userEvent.click(screen.getByRole('button', { name: /Disconnect/i }))
    expect(onDelete).not.toHaveBeenCalled()

    // Accepted confirm → call.
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true)
    await userEvent.click(screen.getByRole('button', { name: /Disconnect/i }))
    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1))
  })

  it('shows the success banner from ?github=connected and strips the param', async () => {
    window.history.replaceState({}, '', '/settings?github=connected')
    const { api } = fakeApi({ connected: false, configured: true })
    wrap(api)
    expect(await screen.findByText(/GitHub connected\./i)).toBeInTheDocument()
    // The param is cleared so a refresh doesn't re-show it.
    expect(window.location.search).not.toContain('github=connected')
  })

  it('shows an error banner from ?github=error', async () => {
    window.history.replaceState({}, '', '/settings?github=error')
    const { api } = fakeApi({ connected: false, configured: true })
    wrap(api)
    expect(await screen.findByText(/connection failed/i)).toBeInTheDocument()
  })

  it('settings.github.* keys have full EN↔TR parity + the dead repo keys are GONE (A2.1)', () => {
    const keys = (loc: 'en' | 'tr'): string[] => Object.keys(STRINGS[loc]).filter(k => k.startsWith('settings.github.')).sort()
    expect(keys('en')).toEqual(keys('tr'))
    // The token-only disclosure exists in both locales.
    expect(STRINGS.en['settings.github.autoRepoNote']).toBeTruthy()
    expect(STRINGS.tr['settings.github.autoRepoNote']).toBeTruthy()
    // The now-dead repo-input keys were removed (no orphan translations).
    for (const k of ['settings.github.repoLabel', 'settings.github.repoPlaceholder', 'settings.github.repoHint', 'settings.github.repoInvalid'] as const) {
      expect(k in STRINGS.en).toBe(false)
      expect(k in STRINGS.tr).toBe(false)
    }
  })
})
