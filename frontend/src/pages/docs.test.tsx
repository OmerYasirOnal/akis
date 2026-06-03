import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { DocsPage } from './DocsPage.js'
import { I18nProvider } from '../i18n/I18nContext.js'
import { RouterProvider } from '../router/router.js'
import { AuthProvider } from '../auth/AuthContext.js'
import { ApiClient } from '../api/client.js'
import { STRINGS } from '../i18n/catalog.js'

beforeEach(() => { window.history.pushState({}, '', '/docs') })

// An ApiClient whose fetch always rejects → AuthProvider resolves to the anon
// (signed-out) state, exercising the public-docs CTA path. No network is hit.
const anonApi = (): ApiClient => new ApiClient('', () => Promise.reject(new Error('offline')))

const renderDocs = () =>
  render(
    <I18nProvider>
      <RouterProvider>
        <AuthProvider api={anonApi()}>
          <DocsPage />
        </AuthProvider>
      </RouterProvider>
    </I18nProvider>,
  )

describe('DocsPage', () => {
  it('renders the hero title and the key section headings', async () => {
    renderDocs()
    // findBy* flushes the AuthProvider effect inside act() before asserting.
    expect(await screen.findByText(STRINGS.en['docs.v2.title'])).toBeInTheDocument()
    // A representative spread of the documented sections (heading level 2).
    for (const k of ['docs.v2.what.title', 'docs.v2.gates.title', 'docs.v2.agents.title', 'docs.v2.selfhost.title', 'docs.v2.faq.title'] as const) {
      expect(screen.getByRole('heading', { level: 2, name: STRINGS.en[k] })).toBeInTheDocument()
    }
  })

  it('renders the on-page table of contents with an entry per section', async () => {
    renderDocs()
    const toc = await screen.findByRole('navigation', { name: STRINGS.en['docs.v2.toc'] })
    // Every TOC link points at its in-page anchor.
    expect(within(toc).getByRole('link', { name: STRINGS.en['docs.v2.nav.gates'] })).toHaveAttribute('href', '#gates')
    expect(within(toc).getByRole('link', { name: STRINGS.en['docs.v2.nav.selfhost'] })).toHaveAttribute('href', '#selfhost')
  })

  it('documents the 4 structural gates and the agent roster', async () => {
    renderDocs()
    expect(await screen.findByText(STRINGS.en['docs.v2.gates.g1.t'])).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['docs.v2.gates.g4.t'])).toBeInTheDocument()
    // Trace is the verifier agent — documented in the roster.
    expect(screen.getByText(STRINGS.en['docs.v2.agents.trace.t'])).toBeInTheDocument()
  })
})
