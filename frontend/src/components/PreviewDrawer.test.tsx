import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
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
    onReset: () => {},
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
    // No DESKTOP edge-tab when open (the mobile FAB is a separate, always-present pocket handle).
    expect(screen.queryByTestId('preview-edge-tab')).toBeNull()
  })

  it('closed drawer is translated off and shows the edge-tab', () => {
    renderDrawer({ open: false })
    expect(screen.getByTestId('preview-drawer')).toHaveStyle({ transform: 'translateX(100%)' })
    // The desktop edge-tab and the mobile FAB share the localized "Open preview" name (CSS gates which is
    // visible), so scope to the edge-tab's testid to avoid the ambiguous role+name match in jsdom.
    expect(screen.getByTestId('preview-edge-tab')).toBeInTheDocument()
  })

  // ISSUE 1 — the closed drawer must carry its REAL width (decoupled from open) so translateX(100%) carries
  // the WHOLE box (✕ included) off-screen, and `overflow-hidden` clips anything that would spill at the edge.
  it('closed drawer keeps its real width var (NOT 0) and clips overflow so nothing spills at the right edge', () => {
    renderDrawer({ open: false })
    const drawer = screen.getByTestId('preview-drawer')
    // The aside reads the SEPARATE always-real width var (the shell supplies the px); never the open-gated one.
    expect(drawer).toHaveStyle({ width: 'var(--preview-drawer-w)' })
    // overflow-hidden so a collapsing/sliding box can't paint at the right edge.
    expect(drawer.className).toContain('overflow-hidden')
    // Off-canvas: the whole drawer (and the ✕ inside it) is translated fully off-screen.
    expect(drawer).toHaveStyle({ transform: 'translateX(100%)' })
  })

  // ISSUE 1 — the close ✕ lives INSIDE the drawer and slides off with it: when closed it must NOT be a visible
  // orphan control. In jsdom we prove this structurally — the close button is a DESCENDANT of the off-canvas,
  // overflow-clipped aside (not a free-floating sibling), so it travels off-screen with the drawer.
  it('the close ✕ lives inside the off-canvas drawer when closed (no orphan close control)', () => {
    renderDrawer({ open: false })
    const drawer = screen.getByTestId('preview-drawer')
    const close = drawer.querySelector<HTMLButtonElement>('button[aria-label="Close preview"]')
    expect(close).not.toBeNull()
    // It is contained by the off-canvas aside (translateX(100%) + overflow-hidden) → carried off-screen.
    expect(drawer.contains(close)).toBe(true)
    expect(drawer).toHaveStyle({ transform: 'translateX(100%)' })
  })

  // ISSUE 2 — the open drawer carries the SAME real width var; the chat-reflow var lives on the shell (parent),
  // never on the aside. Asserts the decouple from both sides.
  it('open drawer also reads the always-real drawer width var (decoupled from the chat-padding var)', () => {
    renderDrawer({ open: true })
    const drawer = screen.getByTestId('preview-drawer')
    expect(drawer).toHaveStyle({ width: 'var(--preview-drawer-w)' })
    expect(drawer).toHaveStyle({ transform: 'translateX(0)' })
  })

  // ISSUE 2 — anti-jumble: the edge-tab must appear ONLY once the close transition has SETTLED, never while
  // the aside is still sliding. Going open→closed, the tab is withheld until the aside's transform
  // transitionend fires; before that the tab and the sliding drawer would otherwise co-exist (the jumble).
  it('edge-tab is withheld while closing and appears only after the slide settles (transitionend)', () => {
    const { rerender } = renderDrawer({ open: true })
    expect(screen.queryByTestId('preview-edge-tab')).toBeNull() // open → no tab
    // Begin closing: the aside starts sliding; the tab must NOT appear yet (it would overlap the slide).
    rerender(<I18nProvider><PreviewDrawer
      open={false} ratio={0.46} onKeyDown={() => {}} onReset={() => {}} onPointerWidth={() => {}}
      commitRatio={() => {}} onOpen={() => {}} onClose={() => {}}
      cards={<div data-testid="cards-slot">cards</div>} preview={<div data-testid="preview-slot">preview</div>}
    /></I18nProvider>)
    expect(screen.queryByTestId('preview-edge-tab')).toBeNull() // still sliding → no tab
    // The slide settles: fire the aside's transform transitionend → NOW the tab may appear.
    act(() => { fireEvent.transitionEnd(screen.getByTestId('preview-drawer'), { propertyName: 'transform' }) })
    expect(screen.getByTestId('preview-edge-tab')).toBeInTheDocument()
  })

  // ISSUE 2 — z-order contract: drawer z-20 < edge-tab z-30 < FAB z-40 < mobile overlay z-50. So even a
  // one-frame paint overlap can never put the tab BEHIND the slid-off drawer.
  it('honors the anti-jumble z-order: drawer z-20 < edge-tab z-30 < FAB z-40', () => {
    renderDrawer({ open: false })
    expect(screen.getByTestId('preview-drawer').className).toContain('z-20')
    expect(screen.getByTestId('preview-edge-tab').className).toContain('z-30')
    expect(screen.getByTestId('preview-fab').className).toContain('z-40')
  })

  it('edge-tab calls onOpen', async () => {
    const onOpen = vi.fn()
    renderDrawer({ open: false, onOpen })
    await userEvent.click(screen.getByTestId('preview-edge-tab'))
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

  it('double-clicking the separator calls onReset (reset-to-default-width affordance)', async () => {
    const onReset = vi.fn()
    renderDrawer({ open: true, onReset })
    await userEvent.dblClick(screen.getByRole('separator'))
    expect(onReset).toHaveBeenCalledTimes(1)
  })

  it('the separator carries the double-click-to-reset hint in its title/aria-description', () => {
    renderDrawer({ open: true })
    const sep = screen.getByRole('separator')
    // EN default; the hint mentions "double-click to reset". (TR mirror exists in the catalog.)
    expect(sep.getAttribute('title')).toMatch(/double-click to reset/i)
    expect(sep.getAttribute('aria-description')).toBe(sep.getAttribute('title'))
  })
})

describe('PreviewDrawer (mobile overlay)', () => {
  // jsdom doesn't evaluate the Tailwind `lg:` breakpoints, so BOTH the desktop drawer and the mobile
  // overlay live in the DOM at once; CSS hides one in a real browser. The mobile overlay's INITIAL show is
  // driven by `allowAutoOpen` (the parent sets it false on small viewports per M1), not the `open` prop —
  // so these tests exercise that JS-level contract directly rather than faking a viewport.

  it('persisted open=true does NOT auto-show the overlay on load; the FAB is shown instead (M1)', () => {
    // The default props carry open=true (a rehydrated persisted state). With allowAutoOpen defaulting to
    // false the overlay must stay closed until an explicit FAB tap — no dialog, only the pocket handle.
    renderDrawer({ open: true })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByTestId('preview-fab')).toBeInTheDocument()
  })

  it('tapping the FAB opens a role=dialog aria-modal overlay with BOTH regions', async () => {
    renderDrawer({ open: true })
    await userEvent.click(screen.getByTestId('preview-fab'))
    const dlg = screen.getByRole('dialog')
    expect(dlg).toHaveAttribute('aria-modal', 'true')
    // Both regions render inside the overlay (the slots are shared with the desktop drawer, so query
    // within the dialog to disambiguate from the desktop copy).
    expect(dlg.querySelector('[data-testid="cards-slot"]')).not.toBeNull()
    expect(dlg.querySelector('[data-testid="preview-slot"]')).not.toBeNull()
  })

  it('Escape on the open overlay calls onClose AND closes the overlay (focus restored to the FAB)', async () => {
    const onClose = vi.fn()
    renderDrawer({ open: true, onClose })
    await userEvent.click(screen.getByTestId('preview-fab'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalled()
    // The overlay is internal view-state: Escape collapses it back to the FAB and returns focus there.
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByTestId('preview-fab')).toHaveFocus()
  })

  it('opening moves focus INTO the overlay panel (focus trap entry)', async () => {
    renderDrawer({ open: true })
    await userEvent.click(screen.getByTestId('preview-fab'))
    const dlg = screen.getByRole('dialog')
    // Focus landed on a control inside the dialog (the close ✕ is the first focusable), not left on body.
    expect(dlg.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).not.toBe(document.body)
  })

  it('the overlay close ✕ collapses it back to the FAB', async () => {
    const onClose = vi.fn()
    renderDrawer({ open: true, onClose })
    await userEvent.click(screen.getByTestId('preview-fab'))
    const dlg = screen.getByRole('dialog')
    const close = dlg.querySelector<HTMLButtonElement>('button[aria-label="Close preview"]')!
    await userEvent.click(close)
    expect(onClose).toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('the FAB carries the verified dot when verified', () => {
    renderDrawer({ open: true, verified: true })
    const dot = screen.getByTestId('preview-fab-dot')
    expect(dot).toBeInTheDocument()
    expect(dot.getAttribute('data-verified')).toBe('true')
  })

  it('Escape with the overlay CLOSED does not call onClose', async () => {
    const onClose = vi.fn()
    renderDrawer({ open: true, onClose })
    // No FAB tap → overlay never opened → Escape is inert (the desktop drawer owns no keyboard close).
    await userEvent.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()
  })
})
