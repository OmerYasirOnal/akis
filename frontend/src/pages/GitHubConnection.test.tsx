import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiClient, type GitHubConnectionStatus } from '../api/client.js'
import { GitHubConnection } from './GitHubConnection.js'
import { I18nProvider } from '../i18n/I18nContext.js'

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
  it('configured:false renders the not-configured note with NO connect button', async () => {
    const { api } = fakeApi({ connected: false, configured: false })
    wrap(api)
    expect(await screen.findByText(/not configured on this server/i)).toBeInTheDocument()
    expect(screen.queryByText(/Connect GitHub/i)).not.toBeInTheDocument()
  })

  it('disconnected renders the repo input + a connect link with the right href', async () => {
    const { api } = fakeApi({ connected: false, configured: true })
    wrap(api)
    const input = await screen.findByLabelText(/Target repository/i)
    await userEvent.type(input, 'ada/app')
    const link = screen.getByText(/Connect GitHub/i).closest('a') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('/auth/github/connect?repo=ada%2Fapp')
  })

  it('the connect link is disabled until a repo is entered', async () => {
    const { api } = fakeApi({ connected: false, configured: true })
    wrap(api)
    await screen.findByLabelText(/Target repository/i)
    const link = screen.getByText(/Connect GitHub/i).closest('a') as HTMLAnchorElement
    expect(link.getAttribute('aria-disabled')).toBe('true')
    expect(link.getAttribute('href')).toBeNull()
  })

  it('connected renders username + repo + a Disconnect button', async () => {
    const { api } = fakeApi({ connected: true, configured: true, username: 'ada', repo: 'ada/app', scopes: ['repo'], connectedAt: new Date().toISOString() })
    wrap(api)
    expect(await screen.findByText('ada')).toBeInTheDocument()
    expect(screen.getByText('ada/app')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Disconnect/i })).toBeInTheDocument()
  })

  it('Disconnect calls the API only after confirm', async () => {
    const onDelete = vi.fn()
    const { api } = fakeApi({ connected: true, configured: true, username: 'ada', repo: 'ada/app' }, onDelete)
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
})
