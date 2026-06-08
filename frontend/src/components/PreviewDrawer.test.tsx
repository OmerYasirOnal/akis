import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PreviewDrawer } from './PreviewDrawer.js'
import { I18nProvider } from '../i18n/I18nContext.js'
import type { ReactElement } from 'react'

/** PreviewDrawer reads i18n strings, so render it inside the provider (default: EN).
 *  Same inline idiom as components.test.tsx — there is no shared ../test/renderI18n.js. */
const renderI18n = (ui: ReactElement) => render(<I18nProvider>{ui}</I18nProvider>)

/** Default props so each test overrides only what it asserts. View-state only — no gates/SSE. */
function renderDrawer(over: Partial<React.ComponentProps<typeof PreviewDrawer>> = {}) {
  const props: React.ComponentProps<typeof PreviewDrawer> = {
    open: true,
    ratio: 0.46,
    onKeyDown: () => {},
    onPointerWidth: () => {},
    commitRatio: () => {},
    onOpen: () => {},
    onClose: () => {},
    cards: <div data-testid="cards-slot">cards</div>,
    preview: <div data-testid="preview-slot">preview</div>,
    ...over,
  }
  return renderI18n(<PreviewDrawer {...props} />)
}

describe('PreviewDrawer (desktop)', () => {
  it('separator exposes the W3C splitter contract', () => {
    renderDrawer({ open: true, ratio: 0.46 })
    const sep = screen.getByRole('separator')
    expect(sep).toHaveAttribute('aria-orientation', 'vertical')
    expect(sep).toHaveAttribute('aria-valuenow', '46')
    expect(sep).toHaveAttribute('aria-valuemin', '25')
    expect(sep).toHaveAttribute('aria-valuemax', '60')
    // aria-valuetext is the localized "Preview {n}% of width" with n interpolated.
    expect(sep.getAttribute('aria-valuetext')).toBe('Preview 46% of width')
    // The separator controls the drawer it lives in.
    const drawer = screen.getByTestId('preview-drawer')
    expect(sep.getAttribute('aria-controls')).toBe(drawer.id)
    expect(drawer.id).toBeTruthy()
    expect(sep).toHaveAttribute('tabindex', '0')
  })

  it('open drawer is on-screen and renders BOTH slots; no edge-tab', () => {
    renderDrawer({ open: true })
    expect(screen.getByTestId('preview-drawer')).toHaveStyle({ transform: 'translateX(0)' })
    expect(screen.getByTestId('cards-slot')).toBeInTheDocument()
    expect(screen.getByTestId('preview-slot')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /open preview|önizlemeyi aç/i })).toBeNull()
  })

  it('closed drawer is translated off and shows the edge-tab', () => {
    renderDrawer({ open: false })
    expect(screen.getByTestId('preview-drawer')).toHaveStyle({ transform: 'translateX(100%)' })
    expect(screen.getByRole('button', { name: /open preview|önizlemeyi aç/i })).toBeInTheDocument()
  })

  it('edge-tab calls onOpen', async () => {
    const onOpen = vi.fn()
    renderDrawer({ open: false, onOpen })
    await userEvent.click(screen.getByRole('button', { name: /open preview|önizlemeyi aç/i }))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('edge-tab carries the verified dot when verified', () => {
    renderDrawer({ open: false, verified: true })
    expect(screen.getByTestId('preview-edge-dot')).toBeInTheDocument()
  })

  it('edge-tab shows an unverified dot when not verified', () => {
    renderDrawer({ open: false, verified: false })
    // The dot is always present; its variant changes — assert it exists + is not the verified variant.
    const dot = screen.getByTestId('preview-edge-dot')
    expect(dot).toBeInTheDocument()
    expect(dot.getAttribute('data-verified')).toBe('false')
  })

  it('close button calls onClose', async () => {
    const onClose = vi.fn()
    renderDrawer({ open: true, onClose })
    await userEvent.click(screen.getByRole('button', { name: /close preview|önizlemeyi kapat/i }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('ArrowLeft on the separator widens (calls onKeyDown)', async () => {
    const onKeyDown = vi.fn()
    renderDrawer({ open: true, onKeyDown })
    screen.getByRole('separator').focus()
    await userEvent.keyboard('{ArrowLeft}')
    expect(onKeyDown).toHaveBeenCalled()
  })
})
