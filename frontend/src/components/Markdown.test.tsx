import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Markdown } from './Markdown.js'

describe('Markdown', () => {
  it('renders bold text as a <strong>', () => {
    render(<Markdown content="this is **bold** text" />)
    const strong = screen.getByText('bold')
    expect(strong.tagName).toBe('STRONG')
  })

  it('renders a bullet list as <ul>/<li>', () => {
    const { container } = render(<Markdown content={'- one\n- two'} />)
    expect(container.querySelector('ul')).not.toBeNull()
    expect(container.querySelectorAll('li').length).toBe(2)
  })

  it('renders inline code as <code>', () => {
    render(<Markdown content="run `npm test` now" />)
    const code = screen.getByText('npm test')
    expect(code.tagName).toBe('CODE')
  })

  it('renders a heading and a horizontal rule', () => {
    const { container } = render(<Markdown content={'# Title\n\n---'} />)
    expect(container.querySelector('h1')?.textContent).toBe('Title')
    expect(container.querySelector('hr')).not.toBeNull()
  })

  it('renders links that open in a new tab with rel=noreferrer', () => {
    const { container } = render(<Markdown content="[AKIS](https://example.com)" />)
    const a = container.querySelector('a')
    expect(a?.getAttribute('href')).toBe('https://example.com')
    expect(a?.getAttribute('target')).toBe('_blank')
    expect(a?.getAttribute('rel')).toContain('noreferrer')
  })

  it('sanitizes a javascript: link href (no script-url sink)', () => {
    // react-markdown's default urlTransform drops dangerous schemes; pin it so a future
    // urlTransform override can never silently re-open a javascript:/data: link sink.
    const { container } = render(<Markdown content="[x](javascript:alert(1))" />)
    const href = container.querySelector('a')?.getAttribute('href') ?? ''
    expect(href.toLowerCase()).not.toContain('javascript:')
  })

  it('does NOT render raw HTML — a <script> tag is shown as text, never executed (XSS guard)', () => {
    const { container } = render(<Markdown content={'before <script>alert(1)</script> after'} />)
    // react-markdown disables raw HTML by default: no real <script> node lands in the DOM.
    expect(container.querySelector('script')).toBeNull()
    // The literal markup survives as text content (escaped), proving no HTML parsing happened.
    expect(container.textContent).toContain('<script>')
  })

  it('does NOT render a raw <img onerror> HTML sink', () => {
    const { container } = render(<Markdown content={'<img src=x onerror="alert(1)">'} />)
    expect(container.querySelector('img')).toBeNull()
  })
})
