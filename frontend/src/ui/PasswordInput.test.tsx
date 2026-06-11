import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PasswordInput } from './PasswordInput.js'
import { I18nProvider } from '../i18n/I18nContext.js'

const ui = (props: Record<string, unknown> = {}) =>
  render(<I18nProvider><PasswordInput aria-label="Password" {...props} /></I18nProvider>)

describe('PasswordInput', () => {
  it('masks by default and reveals on toggle, announcing the state for AT', () => {
    ui()
    const input = screen.getByLabelText('Password') as HTMLInputElement
    expect(input.type).toBe('password')
    const toggle = screen.getByRole('button', { name: 'Show password' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(toggle)
    // revealed: input becomes text, the toggle flips its label + pressed state
    expect((screen.getByLabelText('Password') as HTMLInputElement).type).toBe('text')
    const hide = screen.getByRole('button', { name: 'Hide password' })
    expect(hide).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(hide)
    expect((screen.getByLabelText('Password') as HTMLInputElement).type).toBe('password')
  })

  it('forwards value/autoComplete to the underlying input and the toggle has a keyboard focus ring', () => {
    ui({ value: 'secret', onChange: () => {}, autoComplete: 'current-password' })
    const input = screen.getByLabelText('Password') as HTMLInputElement
    expect(input.value).toBe('secret')
    expect(input.getAttribute('autocomplete')).toBe('current-password')
    // the toggle is keyboard-focusable with the shared teal ring (WCAG 2.4.7)
    expect(screen.getByRole('button').className).toMatch(/focus-visible:ring-2/)
  })
})
