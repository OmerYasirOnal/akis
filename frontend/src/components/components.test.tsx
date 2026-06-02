import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PreviewPanel } from './PreviewPanel.js'
import { emptyView } from '../live/viewModel.js'
import type { SessionView } from '../live/types.js'
import { I18nProvider } from '../i18n/I18nContext.js'
import type { ReactElement } from 'react'

/** PreviewPanel reads i18n strings, so render it inside the provider (default: EN). */
const renderI18n = (ui: ReactElement) => render(<I18nProvider>{ui}</I18nProvider>)

describe('PreviewPanel', () => {
  it('shows the shipped artifact url and pass/fail stats', () => {
    const view: SessionView = { ...emptyView('s1'), preview: { artifactUrl: 'https://github.com/mock/s1', ready: true }, tests: { testsRun: 2, passed: true, ran: true }, verified: true }
    renderI18n(<PreviewPanel view={view} />)
    expect(screen.getByText('https://github.com/mock/s1')).toBeInTheDocument()
    expect(screen.getByText('PASS')).toBeInTheDocument()
    expect(screen.getByText('verified')).toBeInTheDocument()
  })
  it('embeds the running app in an iframe when the url is a /preview/ path', () => {
    const view: SessionView = { ...emptyView('s1'), preview: { url: '/preview/s1/', ready: true } }
    const { container } = renderI18n(<PreviewPanel view={view} />)
    const iframe = container.querySelector('iframe')
    expect(iframe).not.toBeNull()
    expect(iframe?.getAttribute('src')).toBe('/preview/s1/')
  })
  it('never embeds a non-/preview/ url (and the iframe has no allow-same-origin)', () => {
    const view: SessionView = { ...emptyView('s1'), preview: { url: '/preview/s1/', ready: true } }
    const { container } = renderI18n(<PreviewPanel view={view} />)
    expect(container.querySelector('iframe')?.getAttribute('sandbox')).not.toContain('allow-same-origin')
  })
  it('shows a placeholder before any run', () => {
    renderI18n(<PreviewPanel view={emptyView('s1')} />)
    expect(screen.getByText(/Run the app to see it live/)).toBeInTheDocument()
  })
  it('renders a non-http(s) (javascript:) artifact url as plain text, never a clickable href (XSS guard)', () => {
    const view: SessionView = { ...emptyView('s1'), preview: { artifactUrl: 'javascript:alert(1)', ready: true } }
    const { container } = renderI18n(<PreviewPanel view={view} />)
    expect(screen.getByText('javascript:alert(1)')).toBeInTheDocument()
    expect(container.querySelector('a')).toBeNull() // no anchor → no js: sink
  })
  it('never embeds a non-/preview/ url in the iframe (no agent-url sink)', () => {
    const view: SessionView = { ...emptyView('s1'), preview: { url: 'https://evil.example', ready: true } }
    const { container } = renderI18n(<PreviewPanel view={view} />)
    expect(container.querySelector('iframe')).toBeNull()
  })
  it('shows the mock-provider demo note only for the mock provider', () => {
    const mock: SessionView = { ...emptyView('s1'), provider: 'mock' }
    const { rerender } = renderI18n(<PreviewPanel view={mock} />)
    expect(screen.getByText(/Demo preview \(mock provider\)/)).toBeInTheDocument()
    // a real provider must NOT show the note
    rerender(<I18nProvider><PreviewPanel view={{ ...emptyView('s1'), provider: 'anthropic' }} /></I18nProvider>)
    expect(screen.queryByText(/Demo preview \(mock provider\)/)).toBeNull()
  })
  it('keeps the iframe sandbox exactly (allow-scripts allow-forms allow-popups, no allow-same-origin)', () => {
    const view: SessionView = { ...emptyView('s1'), preview: { url: '/preview/s1/', ready: true } }
    const { container } = renderI18n(<PreviewPanel view={view} />)
    expect(container.querySelector('iframe')?.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-popups')
  })
})
