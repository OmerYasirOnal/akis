import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { RunBlock } from './RunBlock.js'
import { I18nProvider } from '../i18n/I18nContext.js'
import { ApiClient } from '../api/client.js'
import { EventStreamClient } from '../live/EventStreamClient.js'
import type { AkisEvent } from '@akis/shared'
import type { SeqEvent } from '../live/types.js'

const wrap = (ui: ReactNode) => <I18nProvider>{ui}</I18nProvider>
beforeEach(() => localStorage.clear())

/** A controllable EventStreamClient-shaped fake. `emit` drives the connected handler. */
class FakeStream {
  static created: FakeStream[] = []
  connectedUrl?: string
  closed = false
  private onEvent?: (e: AkisEvent, seq: number) => void
  constructor() { FakeStream.created.push(this) }
  connect(url: string, h: { onEvent: (e: AkisEvent, seq: number) => void }): void { this.connectedUrl = url; this.onEvent = h.onEvent }
  close(): void { this.closed = true }
  emit(e: AkisEvent, seq: number): void { this.onEvent?.(e, seq) }
}
const ev = (e: Partial<AkisEvent> & { kind: AkisEvent['kind'] }): AkisEvent =>
  ({ agent: 'orchestrator', laneId: 'main', sessionId: 's1', ts: 0, ...(e as object) }) as AkisEvent

/** A fetch double: getSession(:id) → 200 (not gone), getSessionLog(:id) → the supplied events. */
function okFetch(log: SeqEvent[] = []): (path: string) => Promise<Response> {
  return async (path: string) => {
    if (path.endsWith('/log')) return { ok: true, status: 200, json: async () => ({ events: log, head: log.length }), text: async () => '' } as unknown as Response
    return { ok: true, status: 200, json: async () => ({ id: 's1', status: 'running', version: 1 }), text: async () => '' } as unknown as Response
  }
}

describe('RunBlock — inline run-block (strip header + chronological bubbles)', () => {
  it('renders the pipeline-strip HEADER (5 stages + trust ledger) AND the inline chronological bubbles', async () => {
    FakeStream.created = []
    const api = new ApiClient('', vi.fn(okFetch()))
    render(wrap(<RunBlock sessionId="s1" idea="# Todo App" active api={api}
      onApprove={() => {}} onConfirm={() => {}} onNewBuild={() => {}} makeClient={() => new FakeStream() as unknown as EventStreamClient} />))

    // The HEADER is RunPipeline verbatim: the 5 fixed stages + the trust ledger.
    for (const label of ['Spec', 'Build', 'Review', 'Verify', 'Ship']) expect(screen.getByText(label)).toBeInTheDocument()
    expect(screen.getByLabelText('Trust ledger')).toBeInTheDocument()
    // The run-block title is the idea's first heading.
    expect(screen.getByText('Todo App')).toBeInTheDocument()

    // The agent work streams in as INLINE bubbles BELOW the header.
    const live = FakeStream.created[FakeStream.created.length - 1]!
    act(() => {
      live.emit(ev({ kind: 'agent_start', role: 'scribe', agent: 'scribe' }), 1)
      live.emit(ev({ kind: 'verify', testsRun: 3, passed: true, agent: 'trace', laneId: 'verify' }), 2)
      live.emit(ev({ kind: 'done', verified: true, provider: 'anthropic' }), 3)
    })
    // A Scribe agent bubble (the roster/step also says Scribe, hence >=1), a verify card, a done card.
    // "3 tests" appears in BOTH the inline VerifyBubble AND the pipeline summary line (>=1).
    await waitFor(() => expect(screen.getAllByText('Scribe').length).toBeGreaterThanOrEqual(1))
    await waitFor(() => expect(screen.getAllByText(/3 tests/).length).toBeGreaterThanOrEqual(1))
    expect(screen.getByText(/Shipped/)).toBeInTheDocument()
  })

  it('an INLINE gate bubble Approve button calls the injected onApprove — minting nothing client-side', async () => {
    FakeStream.created = []
    const onApprove = vi.fn()
    // Spy the whole API surface: a gate click must NOT hit any session-mutating route — it only
    // calls the bare onApprove callback (the server mints the token).
    const fetchFn = vi.fn(okFetch())
    const api = new ApiClient('', fetchFn)
    render(wrap(<RunBlock sessionId="s1" idea="# App" active api={api}
      onApprove={onApprove} onConfirm={() => {}} onNewBuild={() => {}} makeClient={() => new FakeStream() as unknown as EventStreamClient} />))
    const live = FakeStream.created[FakeStream.created.length - 1]!
    act(() => { live.emit(ev({ kind: 'gate', gate: 'spec_approval', state: 'awaiting' }), 1) })

    // Both the strip-header spec step AND the inline gate bubble surface "Approve spec".
    const approves = await screen.findAllByRole('button', { name: 'Approve spec' })
    expect(approves.length).toBeGreaterThanOrEqual(1)
    await userEvent.click(approves[approves.length - 1]!)
    expect(onApprove).toHaveBeenCalled()
    // GATE-SAFE: clicking the gate minted NOTHING — no approve/run/confirm POST was issued.
    const mutating = fetchFn.mock.calls.filter(c => /\/approve|\/run|\/confirm/.test(String(c[0])))
    expect(mutating).toHaveLength(0)
  })

  it('a RECOVERY button (verify retry) drives the injected api.retryRun — no client mint', async () => {
    FakeStream.created = []
    const api = new ApiClient('', vi.fn(okFetch()))
    const retryRun = vi.spyOn(api, 'retryRun').mockResolvedValue({} as never)
    render(wrap(<RunBlock sessionId="s1" idea="# App" active api={api}
      onApprove={() => {}} onConfirm={() => {}} onNewBuild={() => {}} makeClient={() => new FakeStream() as unknown as EventStreamClient} />))
    const live = FakeStream.created[FakeStream.created.length - 1]!
    act(() => {
      live.emit(ev({ kind: 'verify', testsRun: 2, passed: false, agent: 'trace', laneId: 'verify' }), 1)
      live.emit(ev({ kind: 'recovery', recovery: 'verify_failed', state: 'awaiting' }), 2)
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Retry tests' }))
    expect(retryRun).toHaveBeenCalledWith('s1')
  })

  it('TERMINAL: folds the /log ONCE and does NOT open a live EventSource', async () => {
    FakeStream.created = []
    const log: SeqEvent[] = [
      { seq: 1, event: ev({ kind: 'verify', testsRun: 4, passed: true, agent: 'trace', laneId: 'verify' }) },
      { seq: 2, event: ev({ kind: 'done', verified: true, provider: 'mock' }) },
    ]
    const getSessionLog = vi.fn(async () => log.map(s => s))
    const api = new ApiClient('', vi.fn(okFetch(log)))
    vi.spyOn(api, 'getSessionLog').mockImplementation(getSessionLog as never)
    render(wrap(<RunBlock sessionId="s1" idea="# Old Run" api={api} terminal
      onApprove={() => {}} onConfirm={() => {}} onNewBuild={() => {}} makeClient={() => new FakeStream() as unknown as EventStreamClient} />))

    // The static transcript replays from /log exactly once — no EventSource is created at all.
    await waitFor(() => expect(screen.getAllByText(/4 tests/).length).toBeGreaterThanOrEqual(1))
    expect(screen.getByText(/Shipped/)).toBeInTheDocument()
    expect(getSessionLog).toHaveBeenCalledTimes(1)
    expect(FakeStream.created).toHaveLength(0) // no live subscription for a terminal run
  })

  it('a GONE session (getSession 404) shows the honest recovery card, not a blank block', async () => {
    FakeStream.created = []
    const fetchFn = vi.fn(async (path: string) => {
      if (path.endsWith('/log')) return { ok: true, status: 200, json: async () => ({ events: [], head: 0 }), text: async () => '' } as unknown as Response
      return { ok: false, status: 404, json: async () => ({ error: 'gone' }), text: async () => '' } as unknown as Response
    })
    const api = new ApiClient('', fetchFn)
    const onNewBuild = vi.fn()
    render(wrap(<RunBlock sessionId="s1" idea="# App" active api={api}
      onApprove={() => {}} onConfirm={() => {}} onNewBuild={onNewBuild} makeClient={() => new FakeStream() as unknown as EventStreamClient} />))
    await waitFor(() => expect(screen.getByText(/This session no longer exists/i)).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: 'Start new build' }))
    expect(onNewBuild).toHaveBeenCalled()
  })
})
