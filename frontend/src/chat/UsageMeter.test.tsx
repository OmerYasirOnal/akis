import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { UsageMeter } from './UsageMeter.js'
import { I18nProvider } from '../i18n/I18nContext.js'
import type { UsageInfo } from '../api/client.js'

const ui = (usage: UsageInfo | null) => render(<I18nProvider><UsageMeter usage={usage} /></I18nProvider>)

describe('UsageMeter', () => {
  it('renders used/budget and the remaining headroom', () => {
    const { container } = ui({ usedTokens: 250, budget: 1000, remaining: 750, resetAt: '2026-07-01T00:00:00.000Z' })
    expect(container).toHaveTextContent('250 / 1000')
    expect(container).toHaveTextContent(/left/i)
  })

  it("shows 'Quota reached' (not headroom) when remaining is 0", () => {
    const { container } = ui({ usedTokens: 1000, budget: 1000, remaining: 0, resetAt: '2026-07-01T00:00:00.000Z' })
    expect(container).toHaveTextContent(/Quota reached/i)
    expect(container).not.toHaveTextContent(/left/i)
  })

  it('hides itself (renders nothing) when budget is 0 / unlimited', () => {
    const { container } = ui({ usedTokens: 5, budget: 0, remaining: -1, resetAt: '' })
    expect(container).toBeEmptyDOMElement()
  })

  it('hides itself when usage is null (e.g. a 401 / failed fetch)', () => {
    const { container } = ui(null)
    expect(container).toBeEmptyDOMElement()
  })

  it('compacts large counts (50000 → 50k) so the chip stays small; keeps small numbers exact', () => {
    ui({ usedTokens: 1500, budget: 50000, remaining: 48500, resetAt: '' })
    // 1500 stays exact (< 10k); 50000 → 50k, 48500 → 49k
    expect(screen.getByLabelText(/Tokens: 1500 \/ 50000/)).toHaveTextContent('1500 / 50k')
  })
})
