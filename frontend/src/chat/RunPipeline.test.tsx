import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { RunPipeline } from './RunPipeline.js'
import { I18nProvider } from '../i18n/I18nContext.js'
import { emptyView } from '../live/viewModel.js'
import { ApiClient } from '../api/client.js'
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

  it('makes the trust roles legible — producer (Builder) and INDEPENDENT verifier read as distinct actors', () => {
    render(wrap(<RunPipeline view={emptyView('s1')} onApprove={() => {}} onConfirm={() => {}} />))
    expect(screen.getByText('· Builder')).toBeInTheDocument()
    expect(screen.getByText('· Independent verifier')).toBeInTheDocument()
    expect(screen.getByText('· Human-approved')).toBeInTheDocument()
    expect(screen.getByText('· Your approval')).toBeInTheDocument()
    // Deploy is visibly LOCKED until verification passes (not just an absent button).
    expect(screen.getByText(/Locked until verified/)).toBeInTheDocument()
  })

  it('trust honesty: a demo run says verification is simulated, co-located with the trust headline', () => {
    const live = viewWith({ status: 'running', tests: { testsRun: 2, passed: true, ran: true } })
    const { rerender } = render(wrap(<RunPipeline view={live} onApprove={() => {}} onConfirm={() => {}} />))
    expect(screen.queryByText(/verification is simulated/i)).toBeNull()
    const demo = viewWith({ status: 'running', tests: { testsRun: 2, passed: true, ran: true, demo: true } })
    rerender(wrap(<RunPipeline view={demo} onApprove={() => {}} onConfirm={() => {}} />))
    expect(screen.getByText(/verification is simulated/i)).toBeInTheDocument()
  })

  it('trust ledger: shows the 3 structural tokens cleared vs pending (proof, not copy)', () => {
    // A verified, shipped run: all three tokens cleared.
    const shipped = viewWith({
      status: 'done', verified: true,
      gates: { specApproval: { gate: 'spec_approval', state: 'satisfied' }, pushConfirm: { gate: 'push_confirm', state: 'satisfied' } },
      tests: { testsRun: 2, passed: true, ran: true },
    })
    render(wrap(<RunPipeline view={shipped} onApprove={() => {}} onConfirm={() => {}} />))
    expect(screen.getByLabelText('Trust ledger')).toBeInTheDocument()
    expect(screen.getByText('Spec approved')).toBeInTheDocument()
    expect(screen.getByText('Verified')).toBeInTheDocument()
    expect(screen.getByText('Deploy approved')).toBeInTheDocument()
    // A demo run marks the VerifyToken as standing on a simulated result.
    const demo = viewWith({ status: 'running', tests: { testsRun: 2, passed: true, ran: true, demo: true } })
    const { container } = render(wrap(<RunPipeline view={demo} onApprove={() => {}} onConfirm={() => {}} />))
    expect(container.textContent).toContain('simulated')
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

  it('renders the live-agent-activity slot, COLLAPSED when the run is not in-flight', () => {
    const { container } = render(wrap(<RunPipeline view={emptyView('s1')} onApprove={() => {}} onConfirm={() => {}} details={<div>RAW LOG HERE</div>} />))
    expect(screen.getByText('Live agent activity')).toBeInTheDocument()
    expect(screen.getByText('RAW LOG HERE')).toBeInTheDocument()
    expect(container.querySelector('details')?.open).toBe(false) // idle/terminal → collapsed
  })
  it('defaults the live-agent-activity log OPEN while the run is in-flight (watch each agent work)', () => {
    const view = { ...emptyView('s1'), status: 'running' as const }
    const { container } = render(wrap(<RunPipeline view={view} onApprove={() => {}} onConfirm={() => {}} details={<div>RAW LOG HERE</div>} />))
    expect(container.querySelector('details')?.open).toBe(true)
  })

  // ── Run-state recovery: a parked run shows ACTION buttons (not a silent amber dot). ──
  it('surfaces Proceed/Abandon when the run parks at critic-resolution, and resolveCritic is called', async () => {
    const api = new ApiClient()
    const resolveCritic = vi.spyOn(api, 'resolveCritic').mockResolvedValue({} as never)
    const view = viewWith({
      status: 'running',
      codeReview: { approved: false, findings: 2, critical: false, iteration: 1 },
      recovery: { critic: 'awaiting' },
    }, [{ agent: 'critic', done: true, ok: true, tools: [], notes: [] }])
    render(wrap(<RunPipeline view={view} onApprove={() => {}} onConfirm={() => {}} api={api} />))
    await userEvent.click(screen.getByRole('button', { name: 'Proceed' }))
    expect(resolveCritic).toHaveBeenCalledWith('s1', 'proceed')
    await userEvent.click(screen.getByRole('button', { name: 'Abandon' }))
    await waitFor(() => expect(resolveCritic).toHaveBeenCalledWith('s1', 'abandon'))
    // The recovery hint banner is shown (not a silent dot).
    expect(screen.getByRole('status')).toHaveTextContent(/critic/i)
  })

  it('surfaces a Retry action when verification failed, and retryRun is called', async () => {
    const api = new ApiClient()
    const retryRun = vi.spyOn(api, 'retryRun').mockResolvedValue({} as never)
    const view = viewWith({
      status: 'running',
      tests: { testsRun: 3, passed: false, ran: true },
      verifyFailed: { retry: 'awaiting' },
    }, [{ agent: 'trace', done: true, ok: true, tools: [], notes: [] }])
    render(wrap(<RunPipeline view={view} onApprove={() => {}} onConfirm={() => {}} api={api} />))
    await userEvent.click(screen.getByRole('button', { name: 'Retry tests' }))
    expect(retryRun).toHaveBeenCalledWith('s1')
  })

  it('shows NO recovery action when the run is in a normal (non-parked) state', () => {
    const view = viewWith({ status: 'running', gates: { specApproval: { gate: 'spec_approval', state: 'awaiting' } } })
    render(wrap(<RunPipeline view={view} onApprove={() => {}} onConfirm={() => {}} api={new ApiClient()} />))
    expect(screen.queryByRole('button', { name: 'Proceed' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry tests' })).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  // ── #79 LOW: a CRITICAL critic park surfaces Proceed/Abandon (not a silent dead failed dot). ──
  it('surfaces Proceed/Abandon when the run parks on a CRITICAL critic finding', async () => {
    const api = new ApiClient()
    const resolveCritic = vi.spyOn(api, 'resolveCritic').mockResolvedValue({} as never)
    const view = viewWith({
      status: 'running',
      codeReview: { approved: false, findings: 1, critical: true, iteration: 2 },
      recovery: { critic: 'awaiting' },
    }, [{ agent: 'critic', done: true, ok: true, tools: [], notes: [] }])
    render(wrap(<RunPipeline view={view} onApprove={() => {}} onConfirm={() => {}} api={api} />))
    await userEvent.click(screen.getByRole('button', { name: 'Proceed' }))
    expect(resolveCritic).toHaveBeenCalledWith('s1', 'proceed')
  })

  // ── push_failed retry: a verified run whose push failed surfaces a retry wired to onConfirm. ──
  it('surfaces a "Push failed — retry" action wired to onConfirm when the push failed', async () => {
    const onConfirm = vi.fn()
    const view = viewWith({
      status: 'running', verified: true,
      gates: { specApproval: { gate: 'spec_approval', state: 'satisfied' }, pushConfirm: { gate: 'push_confirm', state: 'awaiting' } },
      tests: { testsRun: 2, passed: true, ran: true },
      pushFailed: { retry: 'awaiting' },
    }, [{ agent: 'trace', done: true, ok: true, tools: [], notes: [] }])
    render(wrap(<RunPipeline view={view} onApprove={() => {}} onConfirm={onConfirm} api={new ApiClient()} />))
    await userEvent.click(screen.getByRole('button', { name: 'Push failed — retry' }))
    expect(onConfirm).toHaveBeenCalled()
    // No duplicate generic Confirm button while push_failed is showing the labeled retry.
    expect(screen.queryByRole('button', { name: 'Confirm push' })).not.toBeInTheDocument()
  })

  // ── Stop/Cancel: while a run is in-flight, a Stop control cancels it (clean abandon). ──
  it('shows a Stop button while a run is in-flight and calls cancelRun', async () => {
    const api = new ApiClient()
    const cancelRun = vi.spyOn(api, 'cancelRun').mockResolvedValue({} as never)
    const view = viewWith({ status: 'running', gates: { specApproval: { gate: 'spec_approval', state: 'awaiting' } } })
    render(wrap(<RunPipeline view={view} onApprove={() => {}} onConfirm={() => {}} api={api} />))
    await userEvent.click(screen.getByRole('button', { name: 'Stop run' }))
    expect(cancelRun).toHaveBeenCalledWith('s1')
  })

  it('keeps the Stop button ENABLED while busy is true (busy no longer greys out cancel)', () => {
    // Liveness regression: approve→run no longer holds `busy` across the whole build, and Stop is
    // gated on `recovering` (a cancel-in-flight), NOT `busy`. A running build with busy=true must
    // still show an ENABLED Stop — the one control whose job is to cancel that very run.
    const running = viewWith({ status: 'running' })
    render(wrap(<RunPipeline view={running} onApprove={() => {}} onConfirm={() => {}} busy={true} api={new ApiClient()} />))
    expect(screen.getByRole('button', { name: 'Stop run' })).toBeEnabled()
  })

  it('hides the Stop button once the run is terminal (done / cancelled)', () => {
    const done = viewWith({ status: 'done', verified: true, gates: { pushConfirm: { gate: 'push_confirm', state: 'satisfied' } } })
    const { rerender } = render(wrap(<RunPipeline view={done} onApprove={() => {}} onConfirm={() => {}} api={new ApiClient()} />))
    expect(screen.queryByRole('button', { name: 'Stop run' })).not.toBeInTheDocument()
    const cancelled = viewWith({ status: 'cancelled' })
    rerender(wrap(<RunPipeline view={cancelled} onApprove={() => {}} onConfirm={() => {}} api={new ApiClient()} />))
    expect(screen.queryByRole('button', { name: 'Stop run' })).not.toBeInTheDocument()
  })

  // ── Per-agent cost badges: present usage shows tokens; absent/zero usage shows time only. ──
  it('renders the metrics badge from a synthetic step log (tokens + time)', () => {
    const view = viewWith({ status: 'running' }, [
      { agent: 'proto', done: true, ok: true, tools: [], notes: [], metrics: { usage: { inTokens: 8000, outTokens: 4345 }, durationMs: 42_000, toolCalls: 1 } },
    ])
    render(wrap(<RunPipeline view={view} onApprove={() => {}} onConfirm={() => {}} />))
    // "12.3k tok · 1 tool · 42s" rides on the build step card.
    expect(screen.getByText(/12\.3k tok · 1 tool · 42s/)).toBeInTheDocument()
  })

  it('absent/zero usage renders time only, NEVER a fabricated 0 tok number', () => {
    // Trace (LLM-free) carries durationMs + toolCalls but NO usage — the badge shows time, never "0 tok".
    const view: SessionView = {
      ...viewWith({ status: 'running' }),
      lanes: [{ laneId: 'verify', steps: [{ agent: 'trace', done: true, ok: true, tools: [], notes: [], metrics: { durationMs: 5_000, toolCalls: 1 } }] }],
    }
    const { container } = render(wrap(<RunPipeline view={view} onApprove={() => {}} onConfirm={() => {}} />))
    expect(screen.getByText(/1 tool · 5s/)).toBeInTheDocument()
    expect(container.textContent).not.toContain('0 tok')
  })
})
