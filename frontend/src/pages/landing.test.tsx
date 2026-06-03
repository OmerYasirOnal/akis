import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Landing } from './Landing.js'
import { I18nProvider } from '../i18n/I18nContext.js'
import { RouterProvider } from '../router/router.js'

beforeEach(() => { window.history.pushState({}, '', '/') })

const renderLanding = () => render(<I18nProvider><RouterProvider><Landing /></RouterProvider></I18nProvider>)

describe('Landing', () => {
  it('renders the hero headline and how-it-works steps', () => {
    renderLanding()
    expect(screen.getAllByText(/Describe an app/i).length).toBeGreaterThan(0)
    expect(screen.getByText('How it works')).toBeInTheDocument()
    expect(screen.getByText('Why AKIS')).toBeInTheDocument()
  })
  it('renders the verified-build-run visual chain from i18n (no hardcoded copy)', () => {
    renderLanding()
    // The decorative chain copy now resolves through the catalogue.
    expect(screen.getByText('verified build run')).toBeInTheDocument()
    expect(screen.getByText('Idea → spec')).toBeInTheDocument()
    expect(screen.getByText('312 passed')).toBeInTheDocument()
    expect(screen.getByText('Push gate')).toBeInTheDocument()
  })
  it('Get started navigates to /signup', async () => {
    renderLanding()
    await userEvent.click(screen.getAllByRole('button', { name: /Get started/i })[0]!)
    expect(window.location.pathname).toBe('/signup')
  })
  it('every sign-in link points to /login', () => {
    renderLanding()
    // The redesigned landing has more than one "Sign in" link (header + footer);
    // assert there is at least one and they ALL route to /login.
    const signins = screen.getAllByRole('link', { name: 'Sign in' })
    expect(signins.length).toBeGreaterThan(0)
    expect(signins.every(a => a.getAttribute('href') === '/login')).toBe(true)
  })
})
