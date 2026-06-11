import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { OAuthButtons } from './OAuthButtons.js'
import { I18nProvider } from '../i18n/I18nContext.js'
import type { ApiClient } from '../api/client.js'

/** A minimal fake ApiClient covering exactly the two methods OAuthButtons calls. */
function makeApi(providers: string[] | Error): ApiClient {
  return {
    getOAuthProviders: vi.fn(() =>
      providers instanceof Error ? Promise.reject(providers) : Promise.resolve({ providers }),
    ),
    oauthAuthorizeUrl: (p: string) => `/oauth/${p}/authorize`,
  } as unknown as ApiClient
}

const ui = (api: ApiClient) => render(<I18nProvider><OAuthButtons api={api} /></I18nProvider>)

describe('OAuthButtons', () => {
  it('renders only the server-configured providers as full-page-redirect anchors (FR-oauth-signin-2)', async () => {
    const api = makeApi(['github'])
    const { container } = ui(api)
    const gh = await screen.findByRole('link', { name: /GitHub/i })
    expect(gh).toHaveAttribute('href', '/oauth/github/authorize')
    expect(screen.queryByRole('link', { name: /Google/i })).toBeNull()
    // the "or" divider appears when at least one provider is present (NFR-oauth-signin-10).
    // Assert it structurally (two hairline rules) so the check isn't coupled to the EN word.
    expect(container.querySelectorAll('span.h-px')).toHaveLength(2)
  })

  it('renders nothing when the provider list is empty (FR-oauth-signin-2 / NFR-16 / UC-7)', async () => {
    const api = makeApi([])
    const { container } = ui(api)
    await waitFor(() => expect(api.getOAuthProviders).toHaveBeenCalled())
    expect(container.firstChild).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('renders nothing when the providers fetch rejects → setProviders([]) (NFR-oauth-signin-16)', async () => {
    const api = makeApi(new Error('network'))
    const { container } = ui(api)
    await waitFor(() => expect(api.getOAuthProviders).toHaveBeenCalled())
    expect(container.firstChild).toBeNull()
  })

  it('uses the REAL multi-color Google mark, not a fabricated "G" disc', async () => {
    const api = makeApi(['google'])
    const { container } = ui(api)
    await screen.findByRole('link', { name: /Google/i })
    // the official 4-color "G" carries Google's brand blue; the old fake glyph rendered a literal "G"
    expect(container.querySelector('svg path[fill="#4285F4"]')).not.toBeNull()
    expect(container.textContent ?? '').not.toMatch(/\bG\b/) // no lone "G" letter glyph
  })

  it('gives both OAuth anchors a keyboard focus-visible ring (WCAG 2.4.7)', async () => {
    const api = makeApi(['github', 'google'])
    ui(api)
    const links = await screen.findAllByRole('link')
    expect(links).toHaveLength(2)
    for (const a of links) expect(a.className).toMatch(/focus-visible:ring-2/)
  })

  it('shows a spinner + aria-busy on the clicked provider while redirecting (and only that one)', async () => {
    const api = makeApi(['github', 'google'])
    const { container } = ui(api)
    const gh = await screen.findByRole('link', { name: /GitHub/i })
    expect(gh).not.toHaveAttribute('aria-busy')
    fireEvent.click(gh) // full-page nav is a jsdom no-op; the onClick still flips redirecting
    expect(screen.getByRole('link', { name: /GitHub/i })).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('link', { name: /Google/i })).not.toHaveAttribute('aria-busy')
    expect(container.querySelector('a[aria-busy="true"] .animate-spin')).not.toBeNull()
  })
})
