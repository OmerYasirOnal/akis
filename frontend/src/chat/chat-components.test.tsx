import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { ChatThread } from './ChatThread.js'
import { ChatStudio } from './ChatStudio.js'
import { I18nProvider } from '../i18n/I18nContext.js'
import { ApiClient } from '../api/client.js'
import { EventStreamClient } from '../live/EventStreamClient.js'
import type { ChatMessage } from './chatModel.js'
import type { AkisEvent } from '@akis/shared'

const wrap = (ui: ReactNode) => <I18nProvider>{ui}</I18nProvider>

describe('ChatThread', () => {
  it('renders an awaiting gate card with an Approve button that fires onApprove', async () => {
    const msgs: ChatMessage[] = [
      { id: 'u', kind: 'user', text: 'build a todo app' },
      { id: 'g', kind: 'gate', gate: 'spec_approval', state: 'awaiting' },
    ]
    const onApprove = vi.fn()
    render(wrap(<ChatThread messages={msgs} onApprove={onApprove} onConfirm={() => {}} />))
    expect(screen.getByText('build a todo app')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Approve spec' }))
    expect(onApprove).toHaveBeenCalled()
  })
  it('hides gate buttons when not awaiting and shows the shipped card', () => {
    const msgs: ChatMessage[] = [
      { id: 'g', kind: 'gate', gate: 'spec_approval', state: 'satisfied' },
      { id: 'd', kind: 'done', verified: true, provider: 'anthropic' },
    ]
    render(wrap(<ChatThread messages={msgs} onApprove={() => {}} onConfirm={() => {}} />))
    expect(screen.queryByRole('button', { name: 'Approve spec' })).toBeNull()
    expect(screen.getByText(/Shipped/)).toBeInTheDocument()
  })
})

/** A controllable fake stream client (EventStreamClient-shaped). */
class FakeStream {
  lastSeq = 0
  private onEvent?: (e: AkisEvent, seq: number) => void
  connect(_url: string, h: { onEvent: (e: AkisEvent, seq: number) => void }): void { this.onEvent = h.onEvent }
  close(): void {}
  emit(e: AkisEvent, seq: number): void { this.onEvent?.(e, seq) }
}

const ev = (e: Partial<AkisEvent> & { kind: AkisEvent['kind'] }): AkisEvent =>
  ({ agent: 'orchestrator', laneId: 'main', sessionId: 's1', ts: 0, ...(e as object) }) as AkisEvent

describe('ChatStudio', () => {
  it('starts a session on send and streams the conversation live', async () => {
    const fetchFn = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/sessions') && init?.method === 'POST') return { ok: true, status: 201, json: async () => ({ id: 's1', status: 'awaiting_spec_approval', version: 1 }), text: async () => '' } as unknown as Response
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response
    })
    const api = new ApiClient('', fetchFn)
    const fake = new FakeStream()
    render(wrap(<ChatStudio api={api} makeClient={() => fake as unknown as EventStreamClient} />))

    await userEvent.type(screen.getByLabelText('idea'), 'build a QR app')
    await userEvent.click(screen.getByRole('button', { name: 'Build' }))
    await waitFor(() => expect(screen.getByText('build a QR app')).toBeInTheDocument()) // user bubble

    act(() => {
      fake.emit(ev({ kind: 'agent_start', role: 'scribe', agent: 'scribe' }), 1)
      fake.emit(ev({ kind: 'gate', gate: 'spec_approval', state: 'awaiting' }), 2)
    })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve spec' })).toBeInTheDocument())
    // "Scribe" appears both in the always-on roster strip and the live thread bubble.
    expect(screen.getAllByText('Scribe').length).toBeGreaterThanOrEqual(2)
  })

  it('autopilot auto-approves the spec gate when it opens (no human click)', async () => {
    const fetchFn = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/sessions') && init?.method === 'POST') return { ok: true, status: 201, json: async () => ({ id: 's1', status: 'awaiting_spec_approval', version: 1 }), text: async () => '' } as unknown as Response
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response
    })
    const api = new ApiClient('', fetchFn)
    const fake = new FakeStream()
    render(wrap(<ChatStudio api={api} makeClient={() => fake as unknown as EventStreamClient} />))

    await userEvent.click(screen.getByLabelText('Autopilot'))
    await userEvent.type(screen.getByLabelText('idea'), 'build a QR app')
    await userEvent.click(screen.getByRole('button', { name: 'Build' }))
    act(() => { fake.emit(ev({ kind: 'gate', gate: 'spec_approval', state: 'awaiting' }), 1) })

    // autopilot should POST /approve and /run without any human interaction
    await waitFor(() => expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('/sessions/s1/approve'), expect.objectContaining({ method: 'POST' })))
    expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('/sessions/s1/run'), expect.objectContaining({ method: 'POST' }))
  })
})
