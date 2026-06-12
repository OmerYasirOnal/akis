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

describe('AgentRoster — F1(b) pre-build scribeOverride', () => {
  // Each agent's localized status appears TWICE in the DOM (an sr-only span + a hidden-then-sm:inline
  // span), so counts are 2× the agent count. The override raises ONLY Scribe above idle: a 'working'/
  // 'done' override means exactly ONE agent (Scribe) is non-idle while the other four stay idle (×2).
  it("raises Scribe to 'working' while drafting (the four others stay idle)", () => {
    render(<I18nProvider><AgentRoster view={emptyView('s1')} scribeOverride="working" /></I18nProvider>)
    expect(screen.getAllByText('working').length).toBe(2) // ONLY Scribe (×2 spans)
    expect(screen.getAllByText('idle').length).toBe(8)    // the four non-Scribe agents (×2 spans)
  })

  it("raises Scribe to 'done' once the spec card is present", () => {
    render(<I18nProvider><AgentRoster view={emptyView('s1')} scribeOverride="done" /></I18nProvider>)
    expect(screen.getAllByText('done').length).toBe(2)
    expect(screen.getAllByText('idle').length).toBe(8)
  })

  it("an 'idle' override is a no-op — every agent reads idle (the override never LOWERS the view)", () => {
    render(<I18nProvider><AgentRoster view={emptyView('s1')} scribeOverride="idle" /></I18nProvider>)
    expect(screen.getAllByText('idle').length).toBe(10) // all five agents (×2 spans), nothing raised
  })

  it('the scribe-only override never flips another role', () => {
    render(<I18nProvider><AgentRoster view={emptyView('s1')} scribeOverride="working" /></I18nProvider>)
    expect(screen.queryAllByText('working').length).toBe(2) // ONLY Scribe — no other role flipped
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

describe('presenceOf — Critic falls back to done/failed on a code_review verdict', () => {
  // The Critic emits a `code_review` verdict but NO agent_start/agent_end, so without this fallback
  // the strip read 'idle'/"beklemede" for the whole build even after the run block said
  // "Kod incelemesi · Onaylandı". The verdict in `view.codeReview` is the proof it ran.
  it('returns "done" for critic on an APPROVED (non-critical) verdict', () => {
    const view = { ...emptyView('s1'), codeReview: { approved: true, findings: 0, critical: false, iteration: 1 } }
    expect(presenceOf(view, 'critic')).toBe('done')
  })

  it('returns "done" for critic on a non-critical rejected verdict (it still finished its pass)', () => {
    const view = { ...emptyView('s1'), codeReview: { approved: false, findings: 3, critical: false, iteration: 2 } }
    expect(presenceOf(view, 'critic')).toBe('done')
  })

  it('returns "failed" for critic on a CRITICAL verdict (mirrors the rose-tone bubble / parked run)', () => {
    const view = { ...emptyView('s1'), codeReview: { approved: false, findings: 5, critical: true, iteration: 1 } }
    expect(presenceOf(view, 'critic')).toBe('failed')
  })

  it('still returns "idle" for critic when no code_review has happened', () => {
    expect(presenceOf(emptyView('s1'), 'critic')).toBe('idle')
  })

  it('the code_review fallback is critic-only — another role stays idle on it', () => {
    const view = { ...emptyView('s1'), codeReview: { approved: true, findings: 0, critical: false, iteration: 1 } }
    expect(presenceOf(view, 'proto')).toBe('idle')
  })
})
