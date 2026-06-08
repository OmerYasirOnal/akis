import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { ChatThread, RecoveryBubble, ChatBubble } from './ChatThread.js'
import { ChatStudio } from './ChatStudio.js'
import { I18nProvider } from '../i18n/I18nContext.js'
import { RouterProvider } from '../router/router.js'
import { ApiClient } from '../api/client.js'
import { EventStreamClient } from '../live/EventStreamClient.js'
import type { ChatMessage } from './chatModel.js'
import type { AkisEvent } from '@akis/shared'

// ChatStudio renders ExternalWriteCard (which SPA-links to /settings) on a done build → needs router.
const wrap = (ui: ReactNode) => <RouterProvider><I18nProvider>{ui}</I18nProvider></RouterProvider>

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

describe('RecoveryBubble', () => {
  it('an AWAITING critic resolution shows Proceed/Abandon wired to the handlers', async () => {
    const onProceed = vi.fn(); const onAbandon = vi.fn()
    render(wrap(<RecoveryBubble m={{ id: 'r', kind: 'recovery', recovery: 'critic_resolution', state: 'awaiting' }}
      onProceed={onProceed} onAbandon={onAbandon} onRetry={() => {}} onConfirm={() => {}} />))
    await userEvent.click(screen.getByRole('button', { name: 'Proceed' }))
    expect(onProceed).toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Abandon' }))
    expect(onAbandon).toHaveBeenCalled()
  })
  it('push_failed RETRY uses onConfirmRecovery (this run\'s session), NOT the active-run onConfirm', async () => {
    const onConfirm = vi.fn(); const onConfirmRecovery = vi.fn()
    render(wrap(<ChatBubble m={{ id: 'r', kind: 'recovery', recovery: 'push_failed', state: 'awaiting' }}
      onApprove={() => {}} onConfirm={onConfirm} onConfirmRecovery={onConfirmRecovery} />))
    await userEvent.click(screen.getByRole('button'))
    expect(onConfirmRecovery).toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled() // the run-block's own session is confirmed, never the active one
  })
  it('a RESOLVED recovery renders nothing (the flow moved on — the next bubble carries the outcome)', () => {
    const { container } = render(wrap(<RecoveryBubble m={{ id: 'r', kind: 'recovery', recovery: 'critic_resolution', state: 'resolved' }}
      onProceed={() => {}} onAbandon={() => {}} onRetry={() => {}} onConfirm={() => {}} />))
    expect(container).toBeEmptyDOMElement()
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
    await userEvent.type(screen.getByLabelText(/ask akis/i), 'build a qr app{Enter}')
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

  it('on build start, scrolls the run HEADER to the top (block:start) instead of the column bottom (H3)', async () => {
    // jsdom has no scrollIntoView — install a spy so we can assert WHAT the auto-scroll targets.
    const spy = vi.fn()
    Object.defineProperty(Element.prototype, 'scrollIntoView', { value: spy, configurable: true, writable: true })
    try {
      const fetchFn = vi.fn(async (path: string, init?: RequestInit) => {
        if (path.endsWith('/api/chat/stream')) return { ok: false, status: 500, json: async () => ({}), text: async () => '' } as unknown as Response
        if (path.endsWith('/api/chat')) return { ok: true, status: 200, json: async () => ({ reply: SPEC_REPLY }), text: async () => '' } as unknown as Response
        if (path.endsWith('/sessions') && init?.method === 'POST') return { ok: true, status: 201, json: async () => ({ id: 's1', status: 'awaiting_spec_approval', version: 1 }), text: async () => '' } as unknown as Response
        return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response
      })
      const api = new ApiClient('', fetchFn)
      const fake = new FakeStream()
      render(wrap(<ChatStudio api={api} makeClient={() => fake as unknown as EventStreamClient} />))

      await userEvent.type(screen.getByLabelText(/ask akis/i), 'build a qr app{Enter}')
      await userEvent.click(await screen.findByRole('button', { name: 'Approve & Build' }))

      // The run marker mounts → its wrapper header is scrolled to the TOP of the viewport.
      await waitFor(() => expect(spy).toHaveBeenCalled())
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ block: 'start' }))
    } finally {
      delete (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView
    }
  })

  it('keeps the user in chat while the workflow starts from the approved spec', async () => {
    const fetchFn = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/api/chat/stream')) return { ok: false, status: 500, json: async () => ({}), text: async () => '' } as unknown as Response
      if (path.endsWith('/api/chat')) return { ok: true, status: 200, json: async () => ({ reply: SPEC_REPLY }), text: async () => '' } as unknown as Response
      if (path.endsWith('/sessions') && init?.method === 'POST') return { ok: true, status: 201, json: async () => ({ id: 's1', status: 'awaiting_spec_approval', version: 1 }), text: async () => '' } as unknown as Response
      if (path.endsWith('/sessions/s1/preview/start')) return { ok: true, status: 200, json: async () => ({ status: 'ready', url: '/preview/s1/' }), text: async () => '' } as unknown as Response
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response
    })
    const api = new ApiClient('', fetchFn)
    const fake = new FakeStream()
    render(wrap(<ChatStudio api={api} makeClient={() => fake as unknown as EventStreamClient} />))

    await userEvent.type(screen.getByLabelText(/ask akis/i), 'build a qr app{Enter}')
    await userEvent.click(await screen.findByRole('button', { name: 'Approve & Build' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Workflow started' })).toBeDisabled())
    expect(screen.getAllByLabelText(/ask akis/i).length).toBeGreaterThanOrEqual(1)
    act(() => fake.emit(ev({ kind: 'done', verified: true, provider: 'mock' }), 1))
    // The preview now lives in a slide-in DRAWER (the in-flow Collapse/Expand <aside> was retired).
    // Closed-by-default → the edge-tab "Open preview" reopens it; the ✕ closes it back. Exercise both.
    const drawer = await screen.findByTestId('preview-drawer')
    expect(drawer).toHaveAttribute('aria-hidden', 'true')
    await userEvent.click(screen.getByTestId('preview-edge-tab')) // "Open preview"
    await waitFor(() => expect(drawer).toHaveAttribute('aria-hidden', 'false'))
    await userEvent.click(screen.getByRole('button', { name: 'Close preview' }))
    await waitFor(() => expect(drawer).toHaveAttribute('aria-hidden', 'true'))
  })

  it('a follow-up approved spec EDITS the prior app: startSession carries baseSessionId once the prior session produced code', async () => {
    const SPEC_REPLY_2 = 'Sure — here is the change 👇\n\n````akis-spec\n# QR App + Login\nAdds a login page.\n````'
    let chatCalls = 0
    const sessionBodies: Record<string, unknown>[] = []
    const fetchFn = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/api/chat/stream')) return { ok: false, status: 500, json: async () => ({}), text: async () => '' } as unknown as Response
      if (path.endsWith('/api/chat')) { chatCalls++; return { ok: true, status: 200, json: async () => ({ reply: chatCalls === 1 ? SPEC_REPLY : SPEC_REPLY_2 }), text: async () => '' } as unknown as Response }
      if (path.endsWith('/sessions') && init?.method === 'POST') {
        sessionBodies.push(JSON.parse(init.body as string) as Record<string, unknown>)
        return { ok: true, status: 201, json: async () => ({ id: sessionBodies.length === 1 ? 's1' : 's2', status: 'awaiting_spec_approval', version: 1 }), text: async () => '' } as unknown as Response
      }
      // The codeFiles re-fetch: the prior session PRODUCED CODE (the edit condition mirrors
      // the backend's code-presence guard, not a status gate).
      if (path.endsWith('/sessions/s1')) return { ok: true, status: 200, json: async () => ({ id: 's1', status: 'done', code: { files: [{ filePath: 'index.html', content: '<html/>' }] }, version: 2 }), text: async () => '' } as unknown as Response
      if (path.endsWith('/sessions/s2')) return { ok: true, status: 200, json: async () => ({ id: 's2', status: 'awaiting_spec_approval', base: { files: [{ filePath: 'index.html', content: '<html/>' }], fromSession: 's1' }, version: 1 }), text: async () => '' } as unknown as Response
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response
    })
    const api = new ApiClient('', fetchFn)
    const fake = new FakeStream()
    render(wrap(<ChatStudio api={api} makeClient={() => fake as unknown as EventStreamClient} />))

    // Build #1 from the conversation (fresh — no base).
    await userEvent.type(screen.getByLabelText(/ask akis/i), 'build a qr app{Enter}')
    await userEvent.click(await screen.findByRole('button', { name: 'Approve & Build' }))
    await waitFor(() => expect(sessionBodies.length).toBe(1))
    expect(sessionBodies[0]).not.toHaveProperty('baseSessionId')

    // Follow-up CHANGE in the same conversation → the next approved spec edits s1.
    await userEvent.type(screen.getAllByLabelText(/ask akis/i)[0]!, 'add a login page{Enter}')
    const approves = await screen.findAllByRole('button', { name: 'Approve & Build' })
    await userEvent.click(approves[approves.length - 1]!)
    await waitFor(() => expect(sessionBodies.length).toBe(2))
    expect(sessionBodies[1]).toMatchObject({ baseSessionId: 's1' })
    // UX honesty: the edit-mode disclosure badge renders for the new session.
    await waitFor(() => expect(screen.getByText(/Editing the previous app/)).toBeInTheDocument())
  })

  it('a follow-up build does NOT carry baseSessionId when the prior session produced no code', async () => {
    const SPEC_REPLY_2 = 'Second spec 👇\n\n````akis-spec\n# Other App\nDifferent.\n````'
    let chatCalls = 0
    const sessionBodies: Record<string, unknown>[] = []
    const fetchFn = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/api/chat/stream')) return { ok: false, status: 500, json: async () => ({}), text: async () => '' } as unknown as Response
      if (path.endsWith('/api/chat')) { chatCalls++; return { ok: true, status: 200, json: async () => ({ reply: chatCalls === 1 ? SPEC_REPLY : SPEC_REPLY_2 }), text: async () => '' } as unknown as Response }
      if (path.endsWith('/sessions') && init?.method === 'POST') {
        sessionBodies.push(JSON.parse(init.body as string) as Record<string, unknown>)
        return { ok: true, status: 201, json: async () => ({ id: `s${sessionBodies.length}`, status: 'awaiting_spec_approval', version: 1 }), text: async () => '' } as unknown as Response
      }
      // Prior session never produced code (e.g. parked at the spec gate) → no edit seed.
      return { ok: true, status: 200, json: async () => ({ id: 's1', status: 'awaiting_spec_approval', version: 1 }), text: async () => '' } as unknown as Response
    })
    const api = new ApiClient('', fetchFn)
    const fake = new FakeStream()
    render(wrap(<ChatStudio api={api} makeClient={() => fake as unknown as EventStreamClient} />))

    await userEvent.type(screen.getByLabelText(/ask akis/i), 'build a qr app{Enter}')
    await userEvent.click(await screen.findByRole('button', { name: 'Approve & Build' }))
    await waitFor(() => expect(sessionBodies.length).toBe(1))

    await userEvent.type(screen.getAllByLabelText(/ask akis/i)[0]!, 'actually build something else{Enter}')
    const approves = await screen.findAllByRole('button', { name: 'Approve & Build' })
    await userEvent.click(approves[approves.length - 1]!)
    await waitFor(() => expect(sessionBodies.length).toBe(2))
    expect(sessionBodies[1]).not.toHaveProperty('baseSessionId')
  })

  it('shows progress instead of a silent Starting button while session creation is pending', async () => {
    let resolveSession: ((r: Response) => void) | undefined
    const fetchFn = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/api/chat/stream')) return { ok: false, status: 500, json: async () => ({}), text: async () => '' } as unknown as Response
      if (path.endsWith('/api/chat')) return { ok: true, status: 200, json: async () => ({ reply: SPEC_REPLY }), text: async () => '' } as unknown as Response
      if (path.endsWith('/sessions') && init?.method === 'POST') {
        return await new Promise<Response>(resolve => { resolveSession = resolve })
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response
    })
    const api = new ApiClient('', fetchFn)
    const fake = new FakeStream()
    render(wrap(<ChatStudio api={api} makeClient={() => fake as unknown as EventStreamClient} />))

    await userEvent.type(screen.getByLabelText(/ask akis/i), 'build a qr app{Enter}')
    await userEvent.click(await screen.findByRole('button', { name: 'Approve & Build' }))

    expect(await screen.findByText('Workflow is starting')).toBeInTheDocument()
    expect(screen.getByText(/Creating the run session/)).toBeInTheDocument()
    expect(screen.getByText(/Elapsed 00:00/)).toBeInTheDocument()

    resolveSession?.({ ok: true, status: 201, json: async () => ({ id: 's1', status: 'awaiting_spec_approval', version: 1 }), text: async () => '' } as unknown as Response)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Workflow started' })).toBeDisabled())
  })

  it('has no separate idea composer or autopilot — the conversation is the only entry', () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response))
    const api = new ApiClient('', fetchFn)
    const fake = new FakeStream()
    render(wrap(<ChatStudio api={api} makeClient={() => fake as unknown as EventStreamClient} />))
    expect(screen.queryByLabelText('idea')).toBeNull()
    expect(screen.queryByLabelText('Autopilot')).toBeNull()
    expect(screen.getByLabelText(/ask akis/i)).toBeInTheDocument()
  })

  // A plain assistant reply (NO akis-spec fence) → the plain-reply bubble, which carries the
  // hover/focus-revealed "Copy reply" button (AssistantMessage is private, so we drive the
  // full studio harness exactly like the spec-flow tests above).
  const PLAIN_REPLY = 'Sure — I can help with that. Tell me a bit more about the app you want.'

  it('shows a Copy reply button on a completed assistant bubble and copies the full reply', async () => {
    const writeText = vi.fn((_text: string) => Promise.resolve())
    Object.assign(navigator, { clipboard: { writeText } })
    const fetchFn = vi.fn(async (path: string) => {
      if (path.endsWith('/api/chat/stream')) return { ok: false, status: 500, json: async () => ({}), text: async () => '' } as unknown as Response
      if (path.endsWith('/api/chat')) return { ok: true, status: 200, json: async () => ({ reply: PLAIN_REPLY }), text: async () => '' } as unknown as Response
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response
    })
    const api = new ApiClient('', fetchFn)
    const fake = new FakeStream()
    render(wrap(<ChatStudio api={api} makeClient={() => fake as unknown as EventStreamClient} />))

    await userEvent.type(screen.getByLabelText(/ask akis/i), 'hello there{Enter}')
    // The greeting bubble is itself a copyable plain reply, so wait for a SECOND Copy reply to
    // appear (the answer), then click the last one and assert it carries the full reply text.
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Copy reply' }).length).toBeGreaterThanOrEqual(2))
    const copyButtons = screen.getAllByRole('button', { name: 'Copy reply' })
    await userEvent.click(copyButtons[copyButtons.length - 1]!)
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(PLAIN_REPLY))
  })

  it('does NOT add a Copy reply for the in-flight bubble while the reply is still streaming', async () => {
    let resolveChat: ((r: Response) => void) | undefined
    const fetchFn = vi.fn(async (path: string) => {
      // Streaming fails → falls back to the non-stream /api/chat, which we keep PENDING so the
      // turn is still in flight (busy) when we count the Copy reply buttons.
      if (path.endsWith('/api/chat/stream')) return { ok: false, status: 500, json: async () => ({}), text: async () => '' } as unknown as Response
      if (path.endsWith('/api/chat')) return await new Promise<Response>(resolve => { resolveChat = resolve })
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response
    })
    const api = new ApiClient('', fetchFn)
    const fake = new FakeStream()
    render(wrap(<ChatStudio api={api} makeClient={() => fake as unknown as EventStreamClient} />))

    // Before sending, the greeting bubble already shows ONE Copy reply.
    const beforeCount = screen.getAllByRole('button', { name: 'Copy reply' }).length
    await userEvent.type(screen.getByLabelText(/ask akis/i), 'hello there{Enter}')
    // The turn is in flight (the thinking cue is up); the in-flight bubble gets NO Copy reply,
    // so the count is unchanged (only the greeting's button is present).
    await screen.findByText(/Thinking/i)
    expect(screen.getAllByRole('button', { name: 'Copy reply' }).length).toBe(beforeCount)
    // Resolve so the completed reply now adds its Copy reply (count grows).
    resolveChat?.({ ok: true, status: 200, json: async () => ({ reply: PLAIN_REPLY }), text: async () => '' } as unknown as Response)
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Copy reply' }).length).toBe(beforeCount + 1))
  })
})
