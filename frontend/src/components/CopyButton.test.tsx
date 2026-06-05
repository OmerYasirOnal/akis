import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { CopyButton } from './CopyButton.js'
import { I18nProvider } from '../i18n/I18nContext.js'

/** CopyButton reads i18n (the "Copied ✓" success label), so render under the provider. */
const renderI18n = (ui: ReactElement) => render(<I18nProvider>{ui}</I18nProvider>)

describe('CopyButton', () => {
  it('writes the given text to the clipboard on click', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.assign(navigator, { clipboard: { writeText } })
    renderI18n(<CopyButton text="hello" label="Copy reply" />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy reply' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('hello'))
  })

  it('flips to the Copied ✓ state after a successful copy', async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn(() => Promise.resolve()) } })
    renderI18n(<CopyButton text="hello" label="Copy reply" />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy reply' }))
    // The accessible name flips to report.copied ("Copied ✓").
    await screen.findByRole('button', { name: /Copied/ })
  })

  it('is a silent no-op when the clipboard is denied (no throw, button persists)', async () => {
    // A rejecting writeText must not surface an unhandled rejection nor crash render.
    Object.assign(navigator, { clipboard: { writeText: vi.fn(() => Promise.reject(new Error('denied'))) } })
    renderI18n(<CopyButton text="hello" label="Copy reply" />)
    const btn = screen.getByRole('button', { name: 'Copy reply' })
    fireEvent.click(btn)
    // Give the rejected promise a microtask turn; the button stays as-is (never the Copied state).
    await Promise.resolve()
    expect(screen.getByRole('button', { name: 'Copy reply' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Copied/ })).toBeNull()
  })
})
