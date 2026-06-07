import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nProvider, useI18n } from './I18nContext.js'

const LANG_KEY = 'akis_lang'

function Harness() {
  const { locale, setLocale } = useI18n()
  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <button onClick={() => setLocale('tr')}>tr</button>
      <button onClick={() => setLocale('en')}>en</button>
    </div>
  )
}

describe('I18nProvider locale persistence', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('persists the chosen locale to localStorage so it survives navigation/reload', async () => {
    render(<I18nProvider><Harness /></I18nProvider>)
    expect(screen.getByTestId('locale').textContent).toBe('en')

    await userEvent.click(screen.getByRole('button', { name: 'tr' }))
    expect(screen.getByTestId('locale').textContent).toBe('tr')
    expect(localStorage.getItem(LANG_KEY)).toBe('tr')
  })

  it('reads the persisted locale on init (a remount sees TR, not EN)', () => {
    localStorage.setItem(LANG_KEY, 'tr')
    render(<I18nProvider><Harness /></I18nProvider>)
    expect(screen.getByTestId('locale').textContent).toBe('tr')
  })

  it('ignores a malformed/unknown persisted value and falls back to the initial locale', () => {
    localStorage.setItem(LANG_KEY, 'zz')
    render(<I18nProvider><Harness /></I18nProvider>)
    expect(screen.getByTestId('locale').textContent).toBe('en')
  })

  it('still honours an explicit initial when nothing is persisted', () => {
    render(<I18nProvider initial="tr"><Harness /></I18nProvider>)
    expect(screen.getByTestId('locale').textContent).toBe('tr')
  })
})
