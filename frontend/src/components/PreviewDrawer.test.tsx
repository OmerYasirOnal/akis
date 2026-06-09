import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
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

  it('open drawer is on-screen and renders BOTH slots; the desktop edge-tab is gone (retired)', () => {
    renderDrawer({ open: true })
    expect(screen.getByTestId('preview-drawer')).toHaveStyle({ transform: 'translateX(0)' })
    expect(screen.getByTestId('cards-slot')).toBeInTheDocument()
    expect(screen.getByTestId('preview-slot')).toBeInTheDocument()
    // The retired vertical-text edge-tab no longer exists — the open affordance lives in the ChatStudio
    // header now (the mobile FAB is a separate, always-present pocket handle).
    expect(screen.queryByTestId('preview-edge-tab')).toBeNull()
  })

  it('closed drawer is translated off; no edge-tab is rendered (the header toggle owns reopen)', () => {
    renderDrawer({ open: false })
    expect(screen.getByTestId('preview-drawer')).toHaveStyle({ transform: 'translateX(100%)' })
    // No drawer-owned reopen control anymore: the ChatStudio header carries the "Preview" toggle.
    expect(screen.queryByTestId('preview-edge-tab')).toBeNull()
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

  // SEAM CALM-DOWN (standards pass): ONE divider on the seam. The aside keeps the single `border-l` hairline
  // and (when OPEN) a single soft teal-tinted left-edge inline boxShadow for elevation — the heavy
  // `shadow-2xl` was dropped so border + shadow + glow aren't all stacked into a "prominent vertical bar".
  it('the open drawer seam is ONE divider: border-l hairline + soft inline shadow, NOT a stacked shadow-2xl', () => {
    renderDrawer({ open: true })
    const drawer = screen.getByTestId('preview-drawer')
    expect(drawer.className).toContain('border-l')
    // The heavy utility shadow is gone (it would stack with the border + inline glow on the seam).
    expect(drawer.className).not.toContain('shadow-2xl')
    // The single elevation cue is the inline left-edge boxShadow (teal-tinted), applied only when open.
    expect(drawer.style.boxShadow).toContain('rgba(7,209,175,0.12)')
  })

  it('the closed drawer carries no elevation shadow (nothing off-screen to elevate)', () => {
    renderDrawer({ open: false })
    const drawer = screen.getByTestId('preview-drawer')
    expect(drawer.className).not.toContain('shadow-2xl')
    expect(drawer.style.boxShadow).toBe('')
  })

  // PADDING PARITY (standards pass): the drawer header + region A use px-4 (16px) so crossing the seam from
  // the chat header (px-4) shows no 12→16 padding jump.
  it('drawer header + region A use px-4/py-* (chat-padding parity, no 12→16 jump at the seam)', () => {
    renderDrawer({ open: true })
    const drawer = screen.getByTestId('preview-drawer')
    const header = drawer.querySelector('button[aria-label="Close preview"]')!.closest('div')!
    expect(header.className).toContain('px-4')
    expect(header.className).toContain('py-3')
    const regionA = screen.getByTestId('cards-slot').parentElement!
    expect(regionA.className).toContain('px-4')
    expect(regionA.className).toContain('py-4')
  })

  // WCAG 2.5.5 — the close ✕ is padded to a ≥44px touch box.
  it('the close ✕ is a ≥44px touch target (h-11 w-11)', () => {
    renderDrawer({ open: true })
    const close = screen.getByRole('button', { name: /close preview/i })
    expect(close.className).toContain('h-11')
    expect(close.className).toContain('w-11')
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

describe('PreviewDrawer (mobile bottom-sheet snaps)', () => {
  // The mobile overlay is a draggable bottom-sheet with three snap points (peek/half/full). The current
  // snap is exposed via `data-snap` (testable) and persisted to localStorage. A grip at the top adjusts
  // the snap (drag on a real device; ArrowUp/ArrowDown/Enter for keyboard, exercised here). jsdom has no
  // layout, so we drive the keyboard path + persistence rather than a pixel drag.
  beforeEach(() => { localStorage.clear() })

  it('opens at the default snap (half) and exposes it via data-snap', async () => {
    renderDrawer({ open: true })
    await userEvent.click(screen.getByTestId('preview-fab'))
    const sheet = screen.getByTestId('preview-sheet')
    expect(sheet).toHaveAttribute('data-snap', 'half')
    // The sheet IS the dialog (the bottom-sheet replaced the full-screen overlay).
    expect(sheet).toHaveAttribute('role', 'dialog')
    expect(sheet).toHaveAttribute('aria-modal', 'true')
  })

  it('reopens at the PERSISTED snap (full) after a prior session left it there', async () => {
    localStorage.setItem('akis_preview_sheet_snap', 'full')
    renderDrawer({ open: true })
    await userEvent.click(screen.getByTestId('preview-fab'))
    expect(screen.getByTestId('preview-sheet')).toHaveAttribute('data-snap', 'full')
  })

  it('the grip is a role=slider with the snap value; ArrowUp/ArrowDown step the snap and persist it', async () => {
    renderDrawer({ open: true }) // starts at the default 'half'
    await userEvent.click(screen.getByTestId('preview-fab'))
    const sheet = screen.getByTestId('preview-sheet')
    const grip = within(sheet).getByRole('slider')
    // The slider exposes the snap: half = index 1 of [peek, half, full].
    expect(grip).toHaveAttribute('aria-valuemin', '0')
    expect(grip).toHaveAttribute('aria-valuemax', '2')
    expect(grip).toHaveAttribute('aria-valuenow', '1')
    expect(grip).toHaveAttribute('aria-valuetext', 'half')

    grip.focus()
    await userEvent.keyboard('{ArrowUp}') // half → full
    expect(sheet).toHaveAttribute('data-snap', 'full')
    expect(grip).toHaveAttribute('aria-valuenow', '2')
    expect(localStorage.getItem('akis_preview_sheet_snap')).toBe('full')

    await userEvent.keyboard('{ArrowDown}') // full → half
    await userEvent.keyboard('{ArrowDown}') // half → peek
    expect(sheet).toHaveAttribute('data-snap', 'peek')
    expect(localStorage.getItem('akis_preview_sheet_snap')).toBe('peek')
  })

  it('Enter on the grip cycles the snap up (full wraps back to peek) for single-control reach', async () => {
    localStorage.setItem('akis_preview_sheet_snap', 'full')
    renderDrawer({ open: true })
    await userEvent.click(screen.getByTestId('preview-fab'))
    const sheet = screen.getByTestId('preview-sheet')
    within(sheet).getByRole('slider').focus()
    await userEvent.keyboard('{Enter}') // full wraps → peek
    expect(sheet).toHaveAttribute('data-snap', 'peek')
  })

  it('the grip is a ≥44px drag/tap band (h-11) with touch-action:none so it owns the vertical drag', async () => {
    renderDrawer({ open: true })
    await userEvent.click(screen.getByTestId('preview-fab'))
    const grip = within(screen.getByTestId('preview-sheet')).getByRole('slider')
    expect(grip.className).toContain('h-11')
    expect(grip.className).toContain('touch-none')
    expect(grip.style.touchAction).toBe('none')
  })

  it('the sheet is bottom-pinned with a snap-driven height (data-snap drives the rendered size)', async () => {
    renderDrawer({ open: true })
    await userEvent.click(screen.getByTestId('preview-fab'))
    const sheet = screen.getByTestId('preview-sheet')
    // Bottom-pinned, rounded-top sheet — not a full-screen inset-0 overlay anymore.
    expect(sheet.className).toContain('bottom-0')
    expect(sheet.className).toContain('rounded-t-2xl')
    // Default 'half' snap → 55dvh height inline (peek/full would be 120px/92dvh).
    expect(sheet.style.height).toBe('55dvh')
  })

  it('under reduced-motion (jsdom has no matchMedia → fail-closed) the snap height change is INSTANT (no transition)', async () => {
    renderDrawer({ open: true })
    await userEvent.click(screen.getByTestId('preview-fab'))
    const sheet = screen.getByTestId('preview-sheet')
    // prefersReducedMotion() fails closed to true when matchMedia is absent → no height transition class.
    expect(sheet.className).not.toContain('transition-[height]')
  })

  it('tapping the scrim (outside the sheet) dismisses; a tap inside the sheet does not', async () => {
    const onClose = vi.fn()
    renderDrawer({ open: true, onClose })
    await userEvent.click(screen.getByTestId('preview-fab'))
    const sheet = screen.getByTestId('preview-sheet')
    // A click INSIDE the sheet must not bubble to the scrim's dismiss handler.
    await userEvent.click(sheet)
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('preview-sheet')).toBeInTheDocument()
    // A click on the scrim (the sheet's parent, outside the panel) dismisses.
    await userEvent.click(sheet.parentElement!)
    expect(onClose).toHaveBeenCalled()
    expect(screen.queryByTestId('preview-sheet')).toBeNull()
  })
})
