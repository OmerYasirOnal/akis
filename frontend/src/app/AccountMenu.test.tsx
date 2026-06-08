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
    await userEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }))
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
})
