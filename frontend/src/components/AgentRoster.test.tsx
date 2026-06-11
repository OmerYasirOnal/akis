import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AgentRoster, presenceOf } from './AgentRoster.js'
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

describe('presenceOf — Scribe falls back to done on a chat-seeded build', () => {
  it('returns "done" for scribe when there is NO scribe lane step but the spec gate is satisfied', () => {
    // Chat-seeded builds short-circuit Scribe's lane, so the only signal that the spec stage
    // happened is the satisfied spec-approval gate. Without the fallback this read as "idle".
    const view = { ...emptyView('s1'), gates: { specApproval: { gate: 'spec_approval' as const, state: 'satisfied' as const } } }
    expect(presenceOf(view, 'scribe')).toBe('done')
  })

  it('still returns "idle" for scribe when nothing has happened (no lane step, no satisfied gate)', () => {
    expect(presenceOf(emptyView('s1'), 'scribe')).toBe('idle')
  })

  it('the satisfied-spec fallback is scribe-only — another role stays idle on it', () => {
    const view = { ...emptyView('s1'), gates: { specApproval: { gate: 'spec_approval' as const, state: 'satisfied' as const } } }
    expect(presenceOf(view, 'proto')).toBe('idle')
  })
})
