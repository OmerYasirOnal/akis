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
