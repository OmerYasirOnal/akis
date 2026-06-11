import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AuthUser } from '../api/client.js'
import { I18nProvider } from '../i18n/I18nContext.js'
import { RouterProvider, useRouter } from '../router/router.js'
import { AccountMenu } from './AccountMenu.js'

beforeEach(() => { window.history.pushState({}, '', '/') })

/** AccountMenu needs the router context (Settings navigates via useRouter). A tiny path probe
 *  lets the navigation assertion read the live path without coupling to App. */
function PathProbe() {
  const { path } = useRouter()
  return <span data-testid="path">{path}</span>
}

function wrap(user: AuthUser, logout: () => void) {
  return render(
    <I18nProvider>
      <RouterProvider>
        <AccountMenu user={user} logout={logout} />
        <PathProbe />
      </RouterProvider>
    </I18nProvider>,
  )
}

const baseUser: AuthUser = { id: '1', name: 'Ada Lovelace', email: 'ada@example.com' }

describe('AccountMenu', () => {
  it('clicking the avatar OPENS the menu and does NOT log out', async () => {
    const logout = vi.fn()
    wrap({ ...baseUser, provider: 'password' }, logout)
    // Closed initially.
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(logout).not.toHaveBeenCalled()
  })

  it('the Sign out item calls logout (the avatar no longer does)', async () => {
    const logout = vi.fn()
    wrap({ ...baseUser, provider: 'password' }, logout)
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }))
    const signOut = screen.getByRole('menuitem', { name: 'Sign out' })
    // destructive action is visually distinguished (muted-rose hover), unlike the benign Settings item
    expect(signOut.className).toMatch(/hover:text-rose-300/)
    expect(screen.getByRole('menuitem', { name: 'Settings' }).className).not.toMatch(/rose/)
    await userEvent.click(signOut)
    expect(logout).toHaveBeenCalledTimes(1)
  })

  it('the provider line reflects user.provider (github)', async () => {
    wrap({ ...baseUser, provider: 'github' }, vi.fn())
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }))
    expect(screen.getByText('Signed in via GitHub')).toBeInTheDocument()
  })

  it('the provider line reflects user.provider (google)', async () => {
    wrap({ ...baseUser, provider: 'google' }, vi.fn())
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }))
    expect(screen.getByText('Signed in via Google')).toBeInTheDocument()
  })

  it('defaults to the Email-account line when provider is absent (older session)', async () => {
    wrap(baseUser, vi.fn())
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }))
    expect(screen.getByText('Email account')).toBeInTheDocument()
  })

  it('Settings navigates via the router (no full reload)', async () => {
    wrap({ ...baseUser, provider: 'password' }, vi.fn())
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Settings' }))
    expect(screen.getByTestId('path').textContent).toBe('/settings')
  })

  it('renders the provider photo when avatarUrl is present, falling back to the initial on error', async () => {
    const { container } = wrap({ ...baseUser, provider: 'github', avatarUrl: 'https://avatars.example/ada.png' }, vi.fn())
    const img = container.querySelector('img') as HTMLImageElement
    expect(img).toBeTruthy()
    expect(img.src).toBe('https://avatars.example/ada.png')
    // A load error degrades to the gradient letter circle (no broken-image glyph).
    // fireEvent wraps the onError state update in act() so React flushes the re-render.
    fireEvent.error(img)
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getAllByText('A').length).toBeGreaterThan(0)
  })

  it('Escape closes the open menu', async () => {
    wrap({ ...baseUser, provider: 'password' }, vi.fn())
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  // ── FR-account-menu-11 (PARTIAL): click-OUTSIDE closes, click-INSIDE keeps it open. ──
  // A regression that widened the close to fire on any mousedown (dropping the
  // `!ref.current.contains(target)` guard) would FAIL the "inside keeps open" assertion.
  it('a mousedown OUTSIDE the panel closes the menu', async () => {
    wrap({ ...baseUser, provider: 'password' }, vi.fn())
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    // The listener is bound to `document` on the `mousedown` event — drive it directly.
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('a mousedown INSIDE the panel does NOT close the menu (ref-contains guard)', async () => {
    wrap({ ...baseUser, provider: 'password' }, vi.fn())
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }))
    const menu = screen.getByRole('menu')
    // Mousedown on a node inside the panel — the contains() guard must keep it open.
    fireEvent.mouseDown(menu)
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  // ── NFR-account-menu-6/-10 + FR-account-menu-11: the effect cleanup must remove BOTH the
  // mousedown AND keydown document listeners on close (and on unmount). A regression that
  // forgot to remove one (or removed the wrong event) would leak a listener and FAIL here. ──
  it('removes BOTH the mousedown and keydown document listeners when the menu closes', async () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener')
    wrap({ ...baseUser, provider: 'password' }, vi.fn())
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }))
    removeSpy.mockClear() // ignore any removes during the open phase; we assert the CLOSE cleanup
    await userEvent.keyboard('{Escape}') // close → effect cleanup runs
    const removed = removeSpy.mock.calls.map(c => c[0])
    expect(removed).toContain('mousedown')
    expect(removed).toContain('keydown')
    removeSpy.mockRestore()
  })

  it('removes BOTH document listeners on unmount (no leak when the menu is open)', async () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener')
    const { unmount } = wrap({ ...baseUser, provider: 'password' }, vi.fn())
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }))
    removeSpy.mockClear()
    unmount()
    const removed = removeSpy.mock.calls.map(c => c[0])
    expect(removed).toContain('mousedown')
    expect(removed).toContain('keydown')
    removeSpy.mockRestore()
  })

  // NFR-account-menu-6: the add↔remove listener accounting must BALANCE across an open→close
  // cycle, so repeated open/close can never accumulate stale document listeners.
  it('balances document add/remove listener counts across an open→close cycle', async () => {
    const addSpy = vi.spyOn(document, 'addEventListener')
    const removeSpy = vi.spyOn(document, 'removeEventListener')
    wrap({ ...baseUser, provider: 'password' }, vi.fn())
    const countFor = (spy: typeof addSpy, ev: string): number => spy.mock.calls.filter(c => c[0] === ev).length
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' })) // open: +mousedown +keydown
    await userEvent.keyboard('{Escape}') // close: cleanup removes both
    for (const ev of ['mousedown', 'keydown'] as const) {
      expect(countFor(addSpy, ev)).toBe(countFor(removeSpy, ev))
    }
    addSpy.mockRestore(); removeSpy.mockRestore()
  })

  // ── NFR-account-menu-8 (PARTIAL): the trigger advertises a menu popup and reflects open state. ──
  // Dropping aria-haspopup or freezing aria-expanded (a common regression when refactoring the
  // toggle) would FAIL this — the closed value must be "false" and flip to "true" once open.
  it('the trigger has aria-haspopup="menu" and toggles aria-expanded false→true on open', async () => {
    wrap({ ...baseUser, provider: 'password' }, vi.fn())
    const trigger = screen.getByRole('button', { name: 'Account menu' })
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
  })

  // ── FR-account-menu-6: the open panel shows the name + email, each with the `truncate` class
  // so a long value never blows out the fixed-width panel. ──
  it('the open menu shows name + email, both carrying the truncate class', async () => {
    wrap({ ...baseUser, provider: 'github' }, vi.fn())
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }))
    const name = screen.getByText('Ada Lovelace')
    const email = screen.getByText('ada@example.com')
    expect(name.className).toContain('truncate')
    expect(email.className).toContain('truncate')
  })

  // ── FR-account-menu-8: the provider line carries the MATCHING glyph and only that one. ──
  // github → GitHub <svg> present, Google glyph absent.
  it('the github provider line renders the GitHubMark svg and NOT the Google glyph', async () => {
    wrap({ ...baseUser, provider: 'github' }, vi.fn())
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }))
    const menu = screen.getByRole('menu')
    // GitHubMark is an inline <svg viewBox="0 0 16 16"> — assert exactly that mark is present.
    expect(menu.querySelector('svg[viewBox="0 0 16 16"]')).toBeTruthy()
    // The Google glyph is the letter "G" circle — it must be absent on a github account.
    expect(screen.queryByText('G')).toBeNull()
  })

  // password → NEITHER glyph (no svg mark, no Google "G").
  it('the password provider line renders NEITHER provider glyph', async () => {
    wrap({ ...baseUser, provider: 'password' }, vi.fn())
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }))
    const menu = screen.getByRole('menu')
    expect(menu.querySelector('svg[viewBox="0 0 16 16"]')).toBeNull()
    expect(screen.queryByText('G')).toBeNull()
    expect(screen.getByText('Email account')).toBeInTheDocument()
  })

  // ── NFR-account-menu-10: the avatar <img> is decorative — alt MUST be the empty string so
  // screen readers don't announce a redundant/duplicated label. ──
  it('the provider photo <img> has an empty alt (decorative)', () => {
    const { container } = wrap({ ...baseUser, provider: 'github', avatarUrl: 'https://avatars.example/ada.png' }, vi.fn())
    const img = container.querySelector('img') as HTMLImageElement
    expect(img).toBeTruthy()
    expect(img.getAttribute('alt')).toBe('')
  })
})
