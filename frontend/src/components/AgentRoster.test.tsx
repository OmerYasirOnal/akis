import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AgentRoster, presenceOf } from './AgentRoster.js'
import { I18nProvider } from '../i18n/I18nContext.js'
import { AGENT_NAMES } from '../agents/names.js'
import { emptyView } from '../live/viewModel.js'
import type { SessionView, StepNode, AgentLane } from '../live/types.js'

/** Build a one-lane view from a list of (agent, done) steps — the most-recent step per role
 *  drives its presence (the active role = the agent whose latest step is still open/working).
 *  status mirrors a real run: still 'running' while any step is open, else 'done'. */
const viewWithSteps = (steps: { agent: StepNode['agent']; done: boolean; ok?: boolean }[]): SessionView => {
  const lane: AgentLane = {
    laneId: 'main',
    steps: steps.map(s => ({ agent: s.agent, done: s.done, tools: [], notes: [], ...(s.ok !== undefined ? { ok: s.ok } : {}) })),
  }
  const anyOpen = steps.some(s => !s.done)
  return { ...emptyView('s1'), status: anyOpen ? 'running' : 'done', lanes: [lane] }
}

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

describe('AgentRoster — responsive strip (mobile-first)', () => {
  // Below `lg` the roster must be ONE horizontally-scrolling row (flex-nowrap + overflow-x-auto with a
  // hidden scrollbar), not 5 stacked rows. At `lg+` it returns to flex-wrap. We assert the utility
  // classes directly (jsdom doesn't evaluate the `lg:` media query, so this is the testable contract).
  it('the roster container is a no-wrap overflow-x strip below lg, restoring wrap at lg+', () => {
    render(<I18nProvider><AgentRoster view={emptyView('s1')} /></I18nProvider>)
    const strip = screen.getByTestId('agent-roster-strip')
    // Base (mobile-first) = single scrollable row.
    expect(strip.className).toContain('flex-nowrap')
    expect(strip.className).toContain('overflow-x-auto')
    // Hidden scrollbar so the strip reads as a clean chip row, not a scroll widget.
    expect(strip.className).toContain('[scrollbar-width:none]')
    // lg+ restores the desktop wrap (unchanged behavior).
    expect(strip.className).toContain('lg:flex-wrap')
    expect(strip.className).toContain('lg:overflow-x-visible')
  })

  it('every chip is shrink-0 so the no-wrap strip scrolls instead of compressing chips illegibly', () => {
    render(<I18nProvider><AgentRoster view={emptyView('s1')} /></I18nProvider>)
    const chips = Array.from(document.querySelectorAll('[data-role]'))
    expect(chips.length).toBe(5) // the full core roster
    for (const chip of chips) expect(chip.className).toContain('shrink-0')
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

describe('AgentRoster — active-agent highlight + live caption', () => {
  it('highlights the currently-running agent (its chip carries data-active="true"; others do not)', () => {
    // Scribe finished, Proto is still OPEN (working) → Proto is the single active role.
    const view = viewWithSteps([{ agent: 'scribe', done: true, ok: true }, { agent: 'proto', done: false }])
    render(<I18nProvider><AgentRoster view={view} /></I18nProvider>)
    const proto = screen.getByText('Proto').closest('[data-role]')!
    expect(proto.getAttribute('data-active')).toBe('true')
    // Every OTHER chip is NOT active.
    const scribe = screen.getByText('Scribe').closest('[data-role]')!
    expect(scribe.getAttribute('data-active')).not.toBe('true')
    expect(screen.getByText('Trace').closest('[data-role]')!.getAttribute('data-active')).not.toBe('true')
  })

  it('the active chip shows the per-role live caption (Proto → "writing code…")', () => {
    const view = viewWithSteps([{ agent: 'proto', done: false }])
    render(<I18nProvider><AgentRoster view={view} /></I18nProvider>)
    expect(screen.getByText('writing code…')).toBeInTheDocument()
  })

  it('no chip is active when there is no working step (all done)', () => {
    const view = viewWithSteps([{ agent: 'scribe', done: true, ok: true }, { agent: 'proto', done: true, ok: true }])
    render(<I18nProvider><AgentRoster view={view} /></I18nProvider>)
    expect(document.querySelector('[data-active="true"]')).toBeNull()
    // …and no live caption is shown when nothing is working.
    expect(screen.queryByText('writing code…')).toBeNull()
  })

  it('no chip is active on an empty/idle view', () => {
    render(<I18nProvider><AgentRoster view={emptyView('s1')} /></I18nProvider>)
    expect(document.querySelector('[data-active="true"]')).toBeNull()
  })
})
