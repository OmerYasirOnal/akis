import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { Markdown } from './Markdown.js'
import { I18nProvider } from '../i18n/I18nContext.js'

// Markdown's <pre> override now calls useI18n() (for the per-block Copy button), so EVERY
// render must be under <I18nProvider> — a bare render would throw "must be used within".
const renderI18n = (ui: ReactElement) => render(<I18nProvider>{ui}</I18nProvider>)

describe('Markdown', () => {
  it('renders bold text as a <strong>', () => {
    renderI18n(<Markdown content="this is **bold** text" />)
    const strong = screen.getByText('bold')
    expect(strong.tagName).toBe('STRONG')
  })

  it('renders a bullet list as <ul>/<li>', () => {
    const { container } = renderI18n(<Markdown content={'- one\n- two'} />)
    expect(container.querySelector('ul')).not.toBeNull()
    expect(container.querySelectorAll('li').length).toBe(2)
  })

  it('renders inline code as <code>', () => {
    renderI18n(<Markdown content="run `npm test` now" />)
    const code = screen.getByText('npm test')
    expect(code.tagName).toBe('CODE')
  })

  it('renders a heading and a horizontal rule', () => {
    const { container } = renderI18n(<Markdown content={'# Title\n\n---'} />)
    expect(container.querySelector('h1')?.textContent).toBe('Title')
    expect(container.querySelector('hr')).not.toBeNull()
  })

  it('renders links that open in a new tab with rel=noreferrer', () => {
    const { container } = renderI18n(<Markdown content="[AKIS](https://example.com)" />)
    const a = container.querySelector('a')
    expect(a?.getAttribute('href')).toBe('https://example.com')
    expect(a?.getAttribute('target')).toBe('_blank')
    expect(a?.getAttribute('rel')).toContain('noreferrer')
  })

  it('sanitizes a javascript: link href (no script-url sink)', () => {
    // react-markdown's default urlTransform drops dangerous schemes; pin it so a future
    // urlTransform override can never silently re-open a javascript:/data: link sink.
    const { container } = renderI18n(<Markdown content="[x](javascript:alert(1))" />)
    const href = container.querySelector('a')?.getAttribute('href') ?? ''
    expect(href.toLowerCase()).not.toContain('javascript:')
  })

  it('does NOT render raw HTML — a <script> tag is shown as text, never executed (XSS guard)', () => {
    const { container } = renderI18n(<Markdown content={'before <script>alert(1)</script> after'} />)
    // react-markdown disables raw HTML by default: no real <script> node lands in the DOM.
    expect(container.querySelector('script')).toBeNull()
    // The literal markup survives as text content (escaped), proving no HTML parsing happened.
    expect(container.textContent).toContain('<script>')
  })

  it('does NOT render a raw <img onerror> HTML sink', () => {
    const { container } = renderI18n(<Markdown content={'<img src=x onerror="alert(1)">'} />)
    expect(container.querySelector('img')).toBeNull()
  })

  describe('fenced code-block copy', () => {
    it('renders one Copy code button per fenced block', () => {
      renderI18n(<Markdown content={'```\none\n```\n\n```\ntwo\n```'} />)
      expect(screen.getAllByRole('button', { name: 'Copy code' })).toHaveLength(2)
    })

    it('copies the exact block text (including the trailing newline react-markdown yields)', async () => {
      const writeText = vi.fn(() => Promise.resolve())
      Object.assign(navigator, { clipboard: { writeText } })
      renderI18n(<Markdown content={'```\nconst x = 1\n```'} />)
      fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))
      await waitFor(() => expect(writeText).toHaveBeenCalledWith('const x = 1\n'))
    })

    it('copies a <script> inside a fence as LITERAL source text, never a real node (XSS guard)', async () => {
      const writeText = vi.fn(() => Promise.resolve())
      Object.assign(navigator, { clipboard: { writeText } })
      const { container } = renderI18n(<Markdown content={'```\n<script>alert(1)</script>\n```'} />)
      // No real script node was injected …
      expect(container.querySelector('script')).toBeNull()
      // … and the copied payload is the literal source string (read from the React tree, not the DOM).
      fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))
      await waitFor(() => expect(writeText).toHaveBeenCalledWith('<script>alert(1)</script>\n'))
    })
  })
})
