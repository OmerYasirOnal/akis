import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AgentRoster } from './AgentRoster.js'
import { I18nProvider } from '../i18n/I18nContext.js'
import { AGENT_NAMES } from '../agents/names.js'
import { emptyView } from '../live/viewModel.js'

/** Minimal render guard: the roster mounts without throwing (so a missing i18n key would
 *  surface), renders every core agent's shared proper noun, and shows the idle status copy. */
describe('AgentRoster', () => {
  it('renders the core roster names and a localized status', () => {
    render(<I18nProvider><AgentRoster view={emptyView('s1')} /></I18nProvider>)
    for (const name of Object.values(AGENT_NAMES)) {
      expect(screen.getAllByText(name).length).toBeGreaterThan(0)
    }
    // every agent is idle on an empty view → the translated idle status renders
    expect(screen.getAllByText('idle').length).toBeGreaterThan(0)
  })
})
