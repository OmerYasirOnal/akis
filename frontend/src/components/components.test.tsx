import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NewSessionForm } from './NewSessionForm.js'
import { GateCards } from './GateCards.js'
import { PreviewPanel } from './PreviewPanel.js'
import { emptyView } from '../live/viewModel.js'
import type { SessionView } from '../live/types.js'

describe('NewSessionForm', () => {
  it('submits the trimmed idea', async () => {
    const onStart = vi.fn()
    render(<NewSessionForm onStart={onStart} />)
    await userEvent.type(screen.getByLabelText('idea'), '  todo app  ')
    await userEvent.click(screen.getByRole('button', { name: 'Build' }))
    expect(onStart).toHaveBeenCalledWith('todo app')
  })
  it('disables Build for an empty idea', () => {
    render(<NewSessionForm onStart={() => {}} />)
    expect(screen.getByRole('button', { name: 'Build' })).toBeDisabled()
  })
})

describe('GateCards', () => {
  const withGate = (state: 'awaiting' | 'satisfied'): SessionView => ({ ...emptyView('s1'), gates: { specApproval: { gate: 'spec_approval', state } } })

  it('enables Approve only when spec approval is awaiting', () => {
    const { rerender } = render(<GateCards view={withGate('awaiting')} onApprove={() => {}} onConfirm={() => {}} />)
    expect(screen.getByRole('button', { name: 'Approve spec' })).toBeEnabled()
    rerender(<GateCards view={withGate('satisfied')} onApprove={() => {}} onConfirm={() => {}} />)
    expect(screen.getByRole('button', { name: 'Approve spec' })).toBeDisabled()
  })
  it('fires onApprove when clicked', async () => {
    const onApprove = vi.fn()
    render(<GateCards view={withGate('awaiting')} onApprove={onApprove} onConfirm={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: 'Approve spec' }))
    expect(onApprove).toHaveBeenCalled()
  })
  it('disables Approve when busy, even if awaiting', () => {
    render(<GateCards view={withGate('awaiting')} onApprove={() => {}} onConfirm={() => {}} busy />)
    expect(screen.getByRole('button', { name: 'Approve spec' })).toBeDisabled()
  })
  it('disables Approve for a rejected gate', () => {
    const view: SessionView = { ...emptyView('s1'), gates: { specApproval: { gate: 'spec_approval', state: 'rejected' } } }
    render(<GateCards view={view} onApprove={() => {}} onConfirm={() => {}} />)
    expect(screen.getByRole('button', { name: 'Approve spec' })).toBeDisabled()
  })
})

describe('PreviewPanel', () => {
  it('shows the artifact url and pass/fail stats', () => {
    const view: SessionView = { ...emptyView('s1'), preview: { url: 'https://github.com/mock/s1', ready: true }, tests: { testsRun: 2, passed: true, ran: true }, verified: true }
    render(<PreviewPanel view={view} />)
    expect(screen.getByText('https://github.com/mock/s1')).toBeInTheDocument()
    expect(screen.getByText('PASS')).toBeInTheDocument()
    expect(screen.getByText('verified')).toBeInTheDocument()
  })
  it('shows a placeholder before any push', () => {
    render(<PreviewPanel view={emptyView('s1')} />)
    expect(screen.getByText(/Preview appears after a verified push/)).toBeInTheDocument()
  })
})
