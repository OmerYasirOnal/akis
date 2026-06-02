import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { RunPipeline } from './RunPipeline.js'
import { I18nProvider } from '../i18n/I18nContext.js'
import { emptyView } from '../live/viewModel.js'
import type { SessionView, AgentLane } from '../live/types.js'

const wrap = (ui: ReactNode) => <I18nProvider>{ui}</I18nProvider>
function viewWith(p: Partial<SessionView>, steps: AgentLane['steps'] = []): SessionView {
  const base = emptyView('s1')
  return { ...base, ...p, lanes: steps.length ? [{ laneId: 'main', steps }] : base.lanes }
}

describe('RunPipeline', () => {
  it('renders the 5 stage labels', () => {
    render(wrap(<RunPipeline view={emptyView('s1')} onApprove={() => {}} onConfirm={() => {}} />))
    for (const label of ['Spec', 'Build', 'Review', 'Verify', 'Ship']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
  })

  it('surfaces an Approve button on the spec step when the spec gate is awaiting', async () => {
    const onApprove = vi.fn()
    const view = viewWith({ status: 'running', gates: { specApproval: { gate: 'spec_approval', state: 'awaiting' } } })
    render(wrap(<RunPipeline view={view} onApprove={onApprove} onConfirm={() => {}} />))
    await userEvent.click(screen.getByRole('button', { name: 'Approve spec' }))
    expect(onApprove).toHaveBeenCalled()
  })

  it('surfaces a Confirm button on the ship step when the push gate is awaiting', async () => {
    const onConfirm = vi.fn()
    const view = viewWith({
      status: 'running', verified: true,
      gates: { specApproval: { gate: 'spec_approval', state: 'satisfied' }, pushConfirm: { gate: 'push_confirm', state: 'awaiting' } },
      tests: { testsRun: 1, passed: true, ran: true },
    })
    render(wrap(<RunPipeline view={view} onConfirm={onConfirm} onApprove={() => {}} />))
    await userEvent.click(screen.getByRole('button', { name: 'Confirm push' }))
    expect(onConfirm).toHaveBeenCalled()
  })

  it('shows a one-line summary when the run is verified + shipped', () => {
    const view = viewWith({
      status: 'done', verified: true, provider: 'anthropic',
      tests: { testsRun: 2, passed: true, ran: true },
      codeReview: { approved: true, findings: 0, critical: false, iteration: 1 },
    })
    render(wrap(<RunPipeline view={view} onApprove={() => {}} onConfirm={() => {}} />))
    // The single summary line carries the verified + tests + review + shipped facts.
    expect(screen.getByText(/✓ Verified · 2 tests · review clean · shipped/)).toBeInTheDocument()
  })

  it('renders the collapsed raw-log details slot', () => {
    render(wrap(<RunPipeline view={emptyView('s1')} onApprove={() => {}} onConfirm={() => {}} details={<div>RAW LOG HERE</div>} />))
    // details is present (default collapsed) and the slot content is in the DOM.
    expect(screen.getByText('Details (raw log)')).toBeInTheDocument()
    expect(screen.getByText('RAW LOG HERE')).toBeInTheDocument()
  })
})
