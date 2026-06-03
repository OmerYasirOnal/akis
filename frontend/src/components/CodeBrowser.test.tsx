import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CodeBrowser } from './CodeBrowser.js'
import { I18nProvider } from '../i18n/I18nContext.js'
import type { ReactElement } from 'react'

/** CodeBrowser reads i18n strings, so render it inside the provider (default: EN). */
const renderI18n = (ui: ReactElement) => render(<I18nProvider>{ui}</I18nProvider>)

const files = [
  { filePath: 'src/index.ts', content: 'export const x = 1\nconsole.log(x)' },
  { filePath: 'README.md', content: '# Hello' },
]

describe('CodeBrowser', () => {
  it('lists every generated file and shows the file count', () => {
    renderI18n(<CodeBrowser files={files} />)
    const list = within(screen.getByRole('list', { name: /Generated code/i }))
    expect(list.getByText('src/index.ts')).toBeInTheDocument()
    expect(list.getByText('README.md')).toBeInTheDocument()
    // file count surfaced
    expect(screen.getByText('2 files')).toBeInTheDocument()
  })

  it('sorts files by path (README.md before src/index.ts)', () => {
    renderI18n(<CodeBrowser files={files} />)
    const items = within(screen.getByRole('list', { name: /Generated code/i }))
      .getAllByRole('listitem')
      .map(li => li.textContent)
    expect(items).toEqual(['README.md', 'src/index.ts'])
  })

  it('selects the first file by default and shows its content with line numbers', () => {
    renderI18n(<CodeBrowser files={files} />)
    // README.md sorts first → shown by default
    expect(screen.getByText('# Hello')).toBeInTheDocument()
    // its single line is numbered "1" (gutter is aria-hidden, so query the DOM directly)
    const gutter = screen.getByTestId('code-gutter')
    expect(gutter.querySelectorAll('li')).toHaveLength(1)
    expect(gutter).toHaveTextContent('1')
  })

  it('shows the selected file content with one gutter line per content line', async () => {
    const user = userEvent.setup()
    renderI18n(<CodeBrowser files={files} />)
    const list = within(screen.getByRole('list', { name: /Generated code/i }))
    await user.click(list.getByText('src/index.ts'))
    expect(screen.getByText('export const x = 1')).toBeInTheDocument()
    expect(screen.getByText('console.log(x)')).toBeInTheDocument()
    const lines = screen.getByTestId('code-gutter').querySelectorAll('li')
    expect(lines).toHaveLength(2) // two content lines → two gutter numbers
  })

  it('renders an empty state when there are no files (no crash)', () => {
    renderI18n(<CodeBrowser files={[]} />)
    expect(screen.getByText(/No code yet/i)).toBeInTheDocument()
    expect(screen.queryByRole('listitem')).toBeNull()
  })

  it('handles undefined files gracefully', () => {
    renderI18n(<CodeBrowser files={undefined} />)
    expect(screen.getByText(/No code yet/i)).toBeInTheDocument()
  })

  it('renders file content as TEXT, never executed/parsed markup (XSS guard)', () => {
    const evil = [{ filePath: 'evil.html', content: '<script>alert(1)</script><img src=x onerror=alert(2)>' }]
    const { container } = renderI18n(<CodeBrowser files={evil} />)
    // The literal source text is shown verbatim …
    expect(screen.getByText('<script>alert(1)</script><img src=x onerror=alert(2)>')).toBeInTheDocument()
    // … and NO real script/img element was injected into the DOM.
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
  })

  it('escapes a malicious file PATH as text too', () => {
    const evil = [{ filePath: '<script>evil</script>.ts', content: 'ok' }]
    const { container } = renderI18n(<CodeBrowser files={evil} />)
    const list = within(screen.getByRole('list', { name: /Generated code/i }))
    expect(list.getByText('<script>evil</script>.ts')).toBeInTheDocument()
    expect(container.querySelector('script')).toBeNull()
  })
})
