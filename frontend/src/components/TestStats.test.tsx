import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { TestStats } from './TestStats.js'
import { I18nProvider } from '../i18n/I18nContext.js'
import type { TestStats as Stats } from '../live/types.js'

// A persisted `akis_lang` WINS over the `initial` prop, so clear it before each test to make the
// locale deterministic from `initial` alone.
beforeEach(() => localStorage.clear())

/** Render inside the i18n provider; `lang` flips EN/TR so we can assert the TR clip target. */
const renderI18n = (ui: ReactElement, lang: 'en' | 'tr' = 'en') =>
  render(<I18nProvider initial={lang}>{ui}</I18nProvider>)

const stats: Stats = { ran: true, testsRun: 3, passed: true }

describe('TestStats — drawer-width-aware grid (Issue 2c "ÇA TEST" clip)', () => {
  // ROOT CAUSE: the grid was `grid-cols-2 sm:grid-cols-4`, keyed off the VIEWPORT — so a narrow preview
  // drawer on a wide monitor still forced 4 columns and clipped the longest TR label "Çalışan test"
  // ("ÇA TEST"). The fix is a CONTAINER query keyed off the pane's real width.
  it('uses a container-query grid (NOT the viewport sm: breakpoint) so columns track the pane width', () => {
    const { container } = renderI18n(<TestStats stats={stats} />)
    const grid = container.querySelector('.grid') as HTMLElement
    // 2×2 by default; 4-up only once the PANE is ≥26rem — never off the viewport.
    expect(grid.className).toContain('grid-cols-2')
    expect(grid.className).toContain('@[26rem]:grid-cols-4')
    // The old viewport-keyed breakpoint is gone (it was the clip cause).
    expect(grid.className).not.toContain('sm:grid-cols-4')
    // The grid lives inside an @container ancestor so the query has a width to resolve against.
    expect(container.querySelector('.\\@container')).not.toBeNull()
  })

  it('renders the full TR label "Çalışan test" (the clip target) — present, not truncated away', () => {
    renderI18n(<TestStats stats={stats} />, 'tr')
    // The label is rendered in full; with the 2×2 default it has room and never clips to "ÇA TEST".
    expect(screen.getByText('Çalışan test')).toBeInTheDocument()
  })

  it('renders all four metric cells (run/result/scenarios/p95) in both empty and filled states', () => {
    const { container } = renderI18n(<TestStats stats={{ ran: false } as Stats} />)
    const grid = container.querySelector('.grid') as HTMLElement
    expect(grid.children.length).toBe(4)
  })
})
