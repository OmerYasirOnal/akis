import { describe, it, expect } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { DemoBadge } from './App.js'
import { ApiClient } from '../api/client.js'
import { I18nProvider } from '../i18n/I18nContext.js'
import { STRINGS } from '../i18n/catalog.js'

/** A fake fetch that answers GET /health with the given mode. */
const healthFetch = (mode: 'live' | 'demo') => (input: string): Promise<Response> => {
  if (input.endsWith('/health')) return Promise.resolve(new Response(JSON.stringify({ ok: true, persistence: 'memory', mode }), { status: 200, headers: { 'content-type': 'application/json' } }))
  return Promise.resolve(new Response('{}', { status: 404 }))
}

const renderI18n = (ui: ReactElement, locale: 'en' | 'tr' = 'en') => render(<I18nProvider initial={locale}>{ui}</I18nProvider>)

describe('B1: DemoBadge surfaces the serving mode from /health', () => {
  it('shows the amber "DEMO · mock-verified" badge when /health reports mode:demo', async () => {
    const api = new ApiClient('', healthFetch('demo'))
    renderI18n(<DemoBadge api={api} />)
    await waitFor(() => expect(screen.getByText(STRINGS.en['mode.demo.badge'])).toBeInTheDocument())
    expect(screen.getByRole('status')).toHaveAttribute('title', STRINGS.en['mode.demo.title'])
  })

  it('renders the TR badge copy under the tr locale', async () => {
    const api = new ApiClient('', healthFetch('demo'))
    renderI18n(<DemoBadge api={api} />, 'tr')
    await waitFor(() => expect(screen.getByText(STRINGS.tr['mode.demo.badge'])).toBeInTheDocument())
  })

  it('renders NOTHING when /health reports mode:live', async () => {
    const api = new ApiClient('', healthFetch('live'))
    const { container } = renderI18n(<DemoBadge api={api} />)
    // give the effect a tick; the badge must never appear for a live boot
    await waitFor(() => expect(container.querySelector('[role="status"]')).toBeNull())
    expect(screen.queryByText(STRINGS.en['mode.demo.badge'])).toBeNull()
  })

  it('stays silent if /health is unreachable (no badge, no crash)', async () => {
    const api = new ApiClient('', () => Promise.reject(new Error('network')))
    const { container } = renderI18n(<DemoBadge api={api} />)
    await waitFor(() => expect(container.querySelector('[role="status"]')).toBeNull())
  })
})
