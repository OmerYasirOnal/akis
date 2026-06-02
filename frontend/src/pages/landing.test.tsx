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
  it('Get started navigates to /signup', async () => {
    renderLanding()
    await userEvent.click(screen.getAllByRole('button', { name: /Get started/i })[0]!)
    expect(window.location.pathname).toBe('/signup')
  })
  it('has a sign-in link to /login', () => {
    renderLanding()
    const signin = screen.getByRole('link', { name: 'Sign in' })
    expect(signin.getAttribute('href')).toBe('/login')
  })
})
