import { describe, it, expect, vi } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/react'
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

  it('copies the selected file content to the clipboard', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    // userEvent.setup() installs a real-ish clipboard (a read-only accessor), so assign via
    // defineProperty(configurable) rather than Object.assign (which would throw on the getter).
    const user = userEvent.setup()
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    renderI18n(<CodeBrowser files={files} />)
    // Select src/index.ts (README.md sorts first by default), then copy its exact content.
    const list = within(screen.getByRole('list', { name: /Generated code/i }))
    await user.click(list.getByText('src/index.ts'))
    await user.click(screen.getByRole('button', { name: 'Copy file' }))
    expect(writeText).toHaveBeenCalledWith('export const x = 1\nconsole.log(x)')
  })

  it('copies ALL files as path-labelled fenced blocks joined by a blank line', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    const user = userEvent.setup()
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    renderI18n(<CodeBrowser files={files} />)
    await user.click(screen.getByRole('button', { name: 'Copy all' }))
    // Files are sorted (README.md before src/index.ts); each fenced block is ```path\ncontent```.
    expect(writeText).toHaveBeenCalledWith(
      '```README.md\n# Hello\n```\n\n```src/index.ts\nexport const x = 1\nconsole.log(x)\n```',
    )
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

  // ── Drag-resizable file-tree splitter (P2.2) ───────────────────────────────────────────────
  describe('resizable file-tree splitter', () => {
    beforeEach(() => localStorage.clear())

    it('renders a vertical resize separator with keyboard/aria affordances', () => {
      renderI18n(<CodeBrowser files={files} />)
      const sep = screen.getByRole('separator')
      expect(sep).toHaveAttribute('aria-orientation', 'vertical')
      expect(sep).toHaveAttribute('tabindex', '0')
      // It exposes a live width value for AT (aria-valuenow), like the drawer splitter.
      expect(sep).toHaveAttribute('aria-valuenow')
    })

    it('keyboard resize changes the tree width AND persists it under the tree key', () => {
      const { unmount } = renderI18n(<CodeBrowser files={files} />)
      const sep = screen.getByRole('separator')
      const before = sep.getAttribute('aria-valuenow')
      // ArrowRight widens the tree (it sits on the left); the persisted value follows.
      fireEvent.keyDown(sep, { key: 'ArrowRight' })
      expect(sep.getAttribute('aria-valuenow')).not.toBe(before)
      const persisted = localStorage.getItem('akis_code_tree_ratio')
      expect(persisted).toBeTruthy()
      unmount()
      // A remount reads the persisted width back (the splitter is stateful across reopen).
      renderI18n(<CodeBrowser files={files} />)
      expect(screen.getByRole('separator').getAttribute('aria-valuenow')).toBe(
        // same rounded percent as the persisted ratio
        String(Math.round(Number(persisted) * 100)),
      )
    })

    it('the tree never collapses below its min (Home keeps it readable)', () => {
      renderI18n(<CodeBrowser files={files} />)
      const sep = screen.getByRole('separator')
      // Home snaps to the clamped minimum — which is still a positive, readable width.
      fireEvent.keyDown(sep, { key: 'Home' })
      const now = Number(sep.getAttribute('aria-valuenow'))
      expect(now).toBeGreaterThan(0)
    })

    it('the editor pane keeps min-w-0 so long lines scroll instead of pushing the tree', () => {
      const { container } = renderI18n(<CodeBrowser files={files} />)
      const editor = container.querySelector('[data-testid="code-editor-pane"]')
      expect(editor).not.toBeNull()
      expect(editor!.className).toMatch(/min-w-0/)
    })

    // GRAB-ABILITY (owner feedback 2 — "the divider can't be grabbed/dragged in the real browser").
    // Root cause: the 12px handle sat FLUSH between two overflow-auto panes with NO z-index, so the
    // panes' scrollbar gutters straddled it and swallowed the pointer; the visible 1px hairline also
    // made the grab target READ as 1px. The fix gives the handle a real wide hit-strip that sits ABOVE
    // both panes (z-index) with its own pointer-events. These structural assertions guard the fix
    // (jsdom can't run a real layout/scrollbar test — we pin the hit-area + stacking contract instead).
    it('the splitter handle is a wide hit-strip stacked ABOVE both panes (grabbable in a real browser)', () => {
      renderI18n(<CodeBrowser files={files} />)
      const sep = screen.getByRole('separator')
      // It must own pointer events and a real cursor + touch contract so a pointer drag starts on it.
      expect(sep.className).toMatch(/cursor-col-resize/)
      expect(sep.style.touchAction).toBe('none')
      // It is lifted above both flex panes (z-index ≥ 20) so neither pane's scrollbar gutter sits over it.
      expect(sep.className).toMatch(/z-20/)
      // The hit-strip straddles the seam (negative inline margin widens it past its 12px box) and is
      // pointer-interactive (never pointer-events-none).
      expect(sep.className).toMatch(/-mx-/)
      expect(sep.className).not.toMatch(/pointer-events-none/)
    })

    it('a pointer drag on the handle changes the tree width and persists it', () => {
      // Stub getBoundingClientRect so the consumer's clientX→ratio math has a real container box in jsdom
      // (jsdom reports a 0-width rect otherwise, which would make every clientX map to the clamped min).
      const proto = HTMLElement.prototype
      const orig = proto.getBoundingClientRect
      proto.getBoundingClientRect = function () {
        // The split container is the [group/split] flex shell; give everything a 1000px-wide box at x=0.
        return { x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 400, width: 1000, height: 400, toJSON() {} } as DOMRect
      }
      try {
        renderI18n(<CodeBrowser files={files} />)
        const sep = screen.getByRole('separator')
        const before = Number(sep.getAttribute('aria-valuenow'))
        // pointerdown on the handle starts the drag; document-level pointermove drives the live ratio;
        // pointerup commits. Dragging RIGHT to clientX=400 → tree ≈ 40% of the 1000px container.
        sep.setPointerCapture = () => {} // jsdom lacks setPointerCapture; stub so onPointerDown doesn't throw
        sep.releasePointerCapture = () => {}
        fireEvent.pointerDown(sep, { button: 0, clientX: 220, pointerId: 1 })
        fireEvent.pointerMove(document, { clientX: 400, pointerId: 1 })
        // rAF flushes the live ratio; flush synchronously for the assertion.
        fireEvent.pointerUp(document, { clientX: 400, pointerId: 1 })
        const after = Number(sep.getAttribute('aria-valuenow'))
        expect(after).not.toBe(before)
        expect(after).toBeGreaterThan(30) // dragged toward 40%
        expect(localStorage.getItem('akis_code_tree_ratio')).toBeTruthy()
      } finally {
        proto.getBoundingClientRect = orig
      }
    })
  })
})
