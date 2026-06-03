import { describe, it, expect, vi, beforeEach } from 'vitest'
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

// A non-stream AKIS reply carrying the Chat-to-Build spec (4-backtick akis-spec fence).
const SPEC_REPLY = 'Here is your build-ready spec 👇\n\n````akis-spec\n# QR App\nA QR code generator.\n````'

describe('ChatStudio', () => {
  beforeEach(() => { localStorage.clear() }) // AkisChat persists the thread; isolate tests

  it('builds ONLY by talking to AKIS: a chat-approved spec starts the live pipeline', async () => {
    const fetchFn = vi.fn(async (path: string, init?: RequestInit) => {
      // Force the streaming path to fail so AkisChat falls back to the non-stream reply,
      // which carries the akis-spec block → the one-click "Approve & Build" card.
      if (path.endsWith('/api/chat/stream')) return { ok: false, status: 500, json: async () => ({}), text: async () => '' } as unknown as Response
      if (path.endsWith('/api/chat')) return { ok: true, status: 200, json: async () => ({ reply: SPEC_REPLY }), text: async () => '' } as unknown as Response
      if (path.endsWith('/sessions') && init?.method === 'POST') return { ok: true, status: 201, json: async () => ({ id: 's1', status: 'awaiting_spec_approval', version: 1 }), text: async () => '' } as unknown as Response
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response
    })
    const api = new ApiClient('', fetchFn)
    const fake = new FakeStream()
    render(wrap(<ChatStudio api={api} makeClient={() => fake as unknown as EventStreamClient} />))

    // The ONLY entry point is the conversation: ask AKIS → it offers a spec → approve it.
    await userEvent.type(screen.getByLabelText('ask-akis'), 'build a qr app{Enter}')
    await userEvent.click(await screen.findByRole('button', { name: 'Approve & Build' }))
    // The session started via the UNCHANGED startSession (no separate idea box / autopilot).
    await waitFor(() => expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('/sessions'), expect.objectContaining({ method: 'POST' })))

    act(() => {
      fake.emit(ev({ kind: 'agent_start', role: 'scribe', agent: 'scribe' }), 1)
      fake.emit(ev({ kind: 'gate', gate: 'spec_approval', state: 'awaiting' }), 2)
    })
    // The live pipeline mounts: the spec gate surfaces an Approve button (>=1; pipeline + raw log).
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Approve spec' }).length).toBeGreaterThanOrEqual(1))
    expect(screen.getAllByText('Scribe').length).toBeGreaterThanOrEqual(2)
  })

  it('has no separate idea composer or autopilot — the conversation is the only entry', () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response))
    const api = new ApiClient('', fetchFn)
    const fake = new FakeStream()
    render(wrap(<ChatStudio api={api} makeClient={() => fake as unknown as EventStreamClient} />))
    expect(screen.queryByLabelText('idea')).toBeNull()
    expect(screen.queryByLabelText('Autopilot')).toBeNull()
    expect(screen.getByLabelText('ask-akis')).toBeInTheDocument()
  })
})
