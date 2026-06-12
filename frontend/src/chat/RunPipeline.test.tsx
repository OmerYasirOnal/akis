import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { RunPipeline } from './RunPipeline.js'
import { I18nProvider } from '../i18n/I18nContext.js'
import { emptyView } from '../live/viewModel.js'
import { ApiClient } from '../api/client.js'
import type { SessionView } from '../live/types.js'

const wrap = (ui: ReactNode) => <I18nProvider>{ui}</I18nProvider>
function viewWith(p: Partial<SessionView>): SessionView {
  return { ...emptyView('s1'), ...p }
}

// RunPipeline is now the SLIM run HEADER (trust headline + trust ledger + Stop + transport banners).
// The 5-stage strip, the gate/recovery ACTION buttons and the per-agent metrics badge were moved
// into the inline conversation bubbles (GateBubble / RecoveryBubble / AgentBubble) — tested there
// (chat-components.test.tsx, RunBlock.test.tsx). These tests pin the header + assert the strip is gone.
describe('RunPipeline (slim run header)', () => {
  it('trust ledger: shows the 3 structural tokens cleared vs pending (proof, not copy)', () => {
    const shipped = viewWith({
      status: 'done', verified: true,
      gates: { specApproval: { gate: 'spec_approval', state: 'satisfied' }, pushConfirm: { gate: 'push_confirm', state: 'satisfied' } },
      tests: { testsRun: 2, passed: true, ran: true },
    })
    render(wrap(<RunPipeline view={shipped} />))
    expect(screen.getByLabelText('Trust ledger')).toBeInTheDocument()
    expect(screen.getByText('Spec approved')).toBeInTheDocument()
    expect(screen.getByText('Verified')).toBeInTheDocument()
    expect(screen.getByText('Deploy approved')).toBeInTheDocument()
  })

  it('trust honesty: a demo run says verification is simulated (co-located with the trust headline)', () => {
    const plain = viewWith({ status: 'running', tests: { testsRun: 2, passed: true, ran: true } })
    const { rerender } = render(wrap(<RunPipeline view={plain} />))
    expect(screen.queryByText(/verification is simulated/i)).toBeNull()
    const demo = viewWith({ status: 'running', tests: { testsRun: 2, passed: true, ran: true, demo: true } })
    rerender(wrap(<RunPipeline view={demo} />))
    expect(screen.getByText(/verification is simulated/i)).toBeInTheDocument()
  })

  it('shows a Stop button while a run is in-flight and calls cancelRun', async () => {
    const api = new ApiClient()
    const cancelRun = vi.spyOn(api, 'cancelRun').mockResolvedValue({} as never)
    render(wrap(<RunPipeline view={viewWith({ status: 'running' })} api={api} />))
    await userEvent.click(screen.getByRole('button', { name: 'Stop run' }))
    expect(cancelRun).toHaveBeenCalledWith('s1')
  })

  it('hides the Stop button once the run is terminal (done / cancelled)', () => {
    const done = viewWith({ status: 'done', verified: true, gates: { pushConfirm: { gate: 'push_confirm', state: 'satisfied' } } })
    const { rerender } = render(wrap(<RunPipeline view={done} api={new ApiClient()} />))
    expect(screen.queryByRole('button', { name: 'Stop run' })).not.toBeInTheDocument()
    rerender(wrap(<RunPipeline view={viewWith({ status: 'cancelled' })} api={new ApiClient()} />))
    expect(screen.queryByRole('button', { name: 'Stop run' })).not.toBeInTheDocument()
  })

  // F2 — a run PARKED awaiting a human recovery is signaled ONLY by a `recovery` event, so
  // view.status stays 'running'. CANCEL_IMMUNE now 409s a cancel of push_failed/verify_failed, so a
  // Stop here would be a silent no-op (a dead button); the inline RecoveryBubble is the actionable
  // surface. Stop must be HIDDEN for each awaiting recovery kind.
  it('F2: hides Stop while a run is parked at an AWAITING push_failed recovery (status still running)', () => {
    const parked = viewWith({ status: 'running', pushFailed: { retry: 'awaiting' } })
    render(wrap(<RunPipeline view={parked} api={new ApiClient()} />))
    expect(screen.queryByRole('button', { name: 'Stop run' })).not.toBeInTheDocument()
  })

  it('F2: hides Stop while a run is parked at an AWAITING verify_failed recovery (status still running)', () => {
    const parked = viewWith({ status: 'running', verifyFailed: { retry: 'awaiting' } })
    render(wrap(<RunPipeline view={parked} api={new ApiClient()} />))
    expect(screen.queryByRole('button', { name: 'Stop run' })).not.toBeInTheDocument()
  })

  it('F2: hides Stop while a run is parked at an AWAITING critic recovery (status still running)', () => {
    const parked = viewWith({ status: 'running', recovery: { critic: 'awaiting' } })
    render(wrap(<RunPipeline view={parked} api={new ApiClient()} />))
    expect(screen.queryByRole('button', { name: 'Stop run' })).not.toBeInTheDocument()
  })

  it('F2: a RESOLVED recovery (the retry is back in flight) restores Stop — the run is live again', () => {
    const resumed = viewWith({ status: 'running', pushFailed: { retry: 'resolved' } })
    render(wrap(<RunPipeline view={resumed} api={new ApiClient()} />))
    expect(screen.getByRole('button', { name: 'Stop run' })).toBeInTheDocument()
  })

  it('is HEADER-ONLY: the 5-stage strip, gate buttons and recovery buttons are NOT rendered here (they are inline bubbles)', () => {
    // A run parked at a gate + a critic recovery — none of the strip/action surfaces appear in the header.
    const view = viewWith({
      status: 'running',
      gates: { specApproval: { gate: 'spec_approval', state: 'awaiting' } },
      recovery: { critic: 'awaiting' },
    })
    const { container } = render(wrap(<RunPipeline view={view} api={new ApiClient()} />))
    expect(screen.queryByText('Build')).toBeNull()       // no stage label strip
    expect(screen.queryByText('· Independent verifier')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Approve spec' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Proceed' })).toBeNull()
    expect(container.querySelector('details')).toBeNull() // no nested chat-in-chat
  })
})
