import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { ChatStudio } from './ChatStudio.js'
import { RunPipeline } from './RunPipeline.js'
import { I18nProvider } from '../i18n/I18nContext.js'
import { ApiClient } from '../api/client.js'
import { EventStreamClient } from '../live/EventStreamClient.js'
import { emptyView } from '../live/viewModel.js'
import type { SessionView } from '../live/types.js'
import type { AkisEvent } from '@akis/shared'

const wrap = (ui: ReactNode) => <I18nProvider>{ui}</I18nProvider>

/** A controllable fake stream client (EventStreamClient-shaped). The gone-card path is driven
 *  by getSession's 404, not by the SSE stream, so this stream stays inert in these tests. */
class FakeStream {
  connectedUrl?: string
  connect(url: string): void { this.connectedUrl = url }
  close(): void {}
}

/** Build a fetch mock for a deep-linked session whose getSession resolves to `getStatus`/`getBody`.
 *  `/sessions/mine` lists the deep-linked id so the deep-link resolves and sets sessionId; then the
 *  getSession effect runs and hits the status we want (404 = gone, 500 = transient, 200 = valid). */
function deepLinkFetch(id: string, getStatus: number, getBody: unknown = {}): (path: string) => Promise<Response> {
  return async (path: string) => {
    if (path.endsWith('/sessions/mine')) {
      return { ok: true, status: 200, json: async () => ([{ id, idea: 'an old build', status: 'done', verified: true }]), text: async () => '' } as unknown as Response
    }
    if (path.endsWith(`/sessions/${id}`)) {
      return { ok: getStatus >= 200 && getStatus < 300, status: getStatus, json: async () => getBody, text: async () => '' } as unknown as Response
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response
  }
}

describe('ChatStudio stale deep-link recovery', () => {
  beforeEach(() => { localStorage.clear(); window.history.replaceState({}, '', '/?s=sgone') })
  afterEach(() => { window.history.replaceState({}, '', '/') })

  it('shows the stale-session card when getSession returns 404', async () => {
    const api = new ApiClient('', vi.fn(deepLinkFetch('sgone', 404, { error: 'not found' })))
    const fake = new FakeStream()
    render(wrap(<ChatStudio api={api} makeClient={() => fake as unknown as EventStreamClient} />))
    // The 404 flips sessionGone → the honest recovery card surfaces with the localized hint.
    await waitFor(() => expect(screen.getByText(/This session no longer exists/i)).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Start new build' })).toBeInTheDocument()
  })

  it('clicking "Start new build" clears the card and drops the ?s= deep-link', async () => {
    const api = new ApiClient('', vi.fn(deepLinkFetch('sgone', 404, { error: 'not found' })))
    const fake = new FakeStream()
    render(wrap(<ChatStudio api={api} makeClient={() => fake as unknown as EventStreamClient} />))
    await waitFor(() => expect(screen.getByText(/This session no longer exists/i)).toBeInTheDocument())

    await userEvent.click(screen.getByRole('button', { name: 'Start new build' }))
    // newChat() resets to a fresh idle conversation: gone-card disappears, ?s= is dropped.
    await waitFor(() => expect(screen.queryByText(/This session no longer exists/i)).toBeNull())
    expect(window.location.search).toBe('')
  })

  it('does NOT show the card for a non-404 error (500) — transient behavior preserved', async () => {
    const api = new ApiClient('', vi.fn(deepLinkFetch('sgone', 500, { error: 'boom' })))
    const fake = new FakeStream()
    render(wrap(<ChatStudio api={api} makeClient={() => fake as unknown as EventStreamClient} />))
    // Let the failing getSession settle, then assert the card never appeared (silent on 5xx).
    await waitFor(() => expect(fake.connectedUrl).toBe('/sessions/sgone/events'))
    await Promise.resolve()
    expect(screen.queryByText(/This session no longer exists/i)).toBeNull()
  })

  it('does NOT show the card when getSession succeeds (valid session)', async () => {
    const api = new ApiClient('', vi.fn(deepLinkFetch('sgone', 200, { id: 'sgone', status: 'done', version: 1 })))
    const fake = new FakeStream()
    render(wrap(<ChatStudio api={api} makeClient={() => fake as unknown as EventStreamClient} />))
    await waitFor(() => expect(fake.connectedUrl).toBe('/sessions/sgone/events'))
    await Promise.resolve()
    expect(screen.queryByText(/This session no longer exists/i)).toBeNull()
  })
})

const viewWith = (p: Partial<SessionView>): SessionView => ({ ...emptyView('s1'), ...p })

describe('RunPipeline sessionGone precedence', () => {
  it('suppresses the connectionGone banner when sessionGone is true', () => {
    const gone = viewWith({ status: 'running', connectionGone: true })
    const { rerender } = render(wrap(<RunPipeline view={gone} sessionGone />))
    // Session is genuinely gone → the gone-card upstream is the recovery path, so the transport
    // "Reload" banner is NOT rendered (it would just hit the same 404).
    expect(screen.queryByText(/Live updates stopped|live updates stopped/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /Reload/i })).toBeNull()
    // But WITHOUT sessionGone (transient transport loss), the banner still renders.
    rerender(wrap(<RunPipeline view={gone} sessionGone={false} />))
    expect(screen.getByRole('button', { name: /Reload/i })).toBeInTheDocument()
  })

  it('suppresses the reconnecting banner when sessionGone is true', () => {
    const lost = viewWith({ status: 'running', connectionLost: true })
    const { rerender } = render(wrap(<RunPipeline view={lost} sessionGone />))
    expect(screen.queryByText(/reconnecting/i)).toBeNull()
    rerender(wrap(<RunPipeline view={lost} sessionGone={false} />))
    expect(screen.getByText(/reconnecting/i)).toBeInTheDocument()
  })
})

describe('ChatStudio — P0-1 single spec approval (chat-approved spec seed)', () => {
  beforeEach(() => { localStorage.clear(); window.history.replaceState({}, '', '/') })
  afterEach(() => { window.history.replaceState({}, '', '/') })

  /** A fetch that: returns an akis-spec reply for the chat, an empty history list, and a created
   *  building session for POST /sessions — capturing the POST body so the test can assert the seed. */
  function studioFetch(captured: { body?: unknown }): (path: string, init?: RequestInit) => Promise<Response> {
    const reply = "Here's a spec 👇\n```akis-spec\n# TODO App\nA list.\n```"
    return async (path: string, init?: RequestInit) => {
      if (path.endsWith('/sessions/mine')) return { ok: true, status: 200, json: async () => [], text: async () => '' } as unknown as Response
      if (path.endsWith('/api/chat/stream')) return { ok: false, status: 404, json: async () => ({}), text: async () => '' } as unknown as Response // force non-stream fallback
      if (path.endsWith('/api/chat')) return { ok: true, status: 200, json: async () => ({ reply }), text: async () => '' } as unknown as Response
      if (path.endsWith('/sessions') && init?.method === 'POST') {
        captured.body = JSON.parse(String(init.body))
        return { ok: true, status: 201, json: async () => ({ id: 'snew', status: 'building', idea: '# TODO App\nA list.', version: 1 }), text: async () => '' } as unknown as Response
      }
      // getSession after the build starts: a building (non-terminal) session.
      if (path.endsWith('/sessions/snew')) return { ok: true, status: 200, json: async () => ({ id: 'snew', status: 'building', version: 1 }), text: async () => '' } as unknown as Response
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response
    }
  }

  it('passes the chat-approved spec as a {title, body} seed to POST /sessions (no second approve)', async () => {
    const captured: { body?: unknown } = {}
    const api = new ApiClient('', vi.fn(studioFetch(captured)))
    const fake = new FakeStream()
    render(wrap(<ChatStudio api={api} makeClient={() => fake as unknown as EventStreamClient} />))

    // Ask AKIS → a SpecCard with "Approve & Build" appears. The composer submit is labeled "Ask".
    await userEvent.type(screen.getByLabelText(/Ask AKIS/i), 'todo app')
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))
    const buildBtn = await screen.findByRole('button', { name: 'Approve & Build' })
    await userEvent.click(buildBtn)

    // The POST body carried the AUTHORITATIVE seed: the title is the spec heading, body is the spec.
    await waitFor(() => expect(captured.body).toBeDefined())
    const body = captured.body as { idea: string; spec?: { title: string; body: string } }
    expect(body.spec).toBeDefined()
    expect(body.spec!.title).toBe('TODO App')
    expect(body.spec!.body).toContain('# TODO App')
  })

  it("P1-6: 'New build' on a NON-TERMINAL run cancels it (api.cancel) before clearing", async () => {
    const captured: { body?: unknown } = {}
    const api = new ApiClient('', vi.fn(studioFetch(captured)))
    const cancelRun = vi.spyOn(api, 'cancelRun').mockResolvedValue({} as never)
    const fake = new FakeStream()
    render(wrap(<ChatStudio api={api} makeClient={() => fake as unknown as EventStreamClient} />))

    await userEvent.type(screen.getByLabelText(/Ask AKIS/i), 'todo app')
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Approve & Build' }))
    // The build started → a non-terminal (building) session. getSession resolves backendStatus.
    await waitFor(() => expect(captured.body).toBeDefined())

    // 'New build' must STOP the running pipeline (not orphan it) before resetting.
    await userEvent.click(await screen.findByRole('button', { name: 'New build' }))
    await waitFor(() => expect(cancelRun).toHaveBeenCalledWith('snew'))
  })
})

// ── ANCHORED MULTI-RUN: two approvals → two inline run-blocks in ONE scroll ──
describe('ChatStudio — anchored multi-run transcript', () => {
  beforeEach(() => { localStorage.clear(); window.history.replaceState({}, '', '/') })
  afterEach(() => { window.history.replaceState({}, '', '/') })

  /** A per-connect fake stream: makeClient returns a NEW instance each call (one per run-block's
   *  useLiveChat), and `latest()` is the most-recently-connected one — the ACTIVE run, since a
   *  terminal run never opens an EventSource (it folds /log instead). emit() drives that one. */
  class EmitStream {
    static created: EmitStream[] = []
    connectedUrl?: string
    private onEvent?: (e: AkisEvent, seq: number) => void
    constructor() { EmitStream.created.push(this) }
    connect(url: string, h: { onEvent: (e: AkisEvent, seq: number) => void }): void { this.connectedUrl = url; this.onEvent = h.onEvent }
    close(): void {}
    emit(e: AkisEvent, seq: number): void { this.onEvent?.(e, seq) }
  }
  const ev = (e: Partial<AkisEvent> & { kind: AkisEvent['kind'] }): AkisEvent =>
    ({ agent: 'orchestrator', laneId: 'main', sessionId: 's1', ts: 0, ...(e as object) }) as AkisEvent

  const SPEC_A = 'Spec A 👇\n\n````akis-spec\n# Run Alpha\nThe first app.\n````'
  const SPEC_B = 'Spec B 👇\n\n````akis-spec\n# Run Beta\nThe second app.\n````'

  /** A studio harness: two distinct chat specs, two created sessions (sA then sB), and getSession
   *  resolving sA WITH code (so the 2nd build base-merges) + sB without. Captures POST bodies. */
  function multiRunFetch(bodies: Record<string, unknown>[]): (path: string, init?: RequestInit) => Promise<Response> {
    let chatCalls = 0
    return async (path: string, init?: RequestInit) => {
      if (path.endsWith('/sessions/mine')) return { ok: true, status: 200, json: async () => [], text: async () => '' } as unknown as Response
      if (path.endsWith('/api/chat/stream')) return { ok: false, status: 500, json: async () => ({}), text: async () => '' } as unknown as Response
      if (path.endsWith('/api/chat')) { chatCalls++; return { ok: true, status: 200, json: async () => ({ reply: chatCalls === 1 ? SPEC_A : SPEC_B }), text: async () => '' } as unknown as Response }
      if (path.endsWith('/sessions') && init?.method === 'POST') {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        return { ok: true, status: 201, json: async () => ({ id: bodies.length === 1 ? 'sA' : 'sB', status: 'running', version: 1 }), text: async () => '' } as unknown as Response
      }
      if (path.endsWith('/sessions/sA')) return { ok: true, status: 200, json: async () => ({ id: 'sA', status: 'done', code: { files: [{ filePath: 'index.html', content: '<html/>' }] }, version: 2 }), text: async () => '' } as unknown as Response
      if (path.endsWith('/sessions/sB')) return { ok: true, status: 200, json: async () => ({ id: 'sB', status: 'running', version: 1 }), text: async () => '' } as unknown as Response
      if (path.endsWith('/sessions/sA/log') || path.endsWith('/sessions/sB/log')) return { ok: true, status: 200, json: async () => ({ events: [], head: 0 }), text: async () => '' } as unknown as Response
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response
    }
  }

  it('two approvals append TWO run-blocks in one scroll; the 2nd build base-merges sA; Stop targets the latest', async () => {
    EmitStream.created = []
    const bodies: Record<string, unknown>[] = []
    const api = new ApiClient('', vi.fn(multiRunFetch(bodies)))
    const cancelRun = vi.spyOn(api, 'cancelRun').mockResolvedValue({} as never)
    render(wrap(<ChatStudio api={api} makeClient={() => new EmitStream() as unknown as EventStreamClient} />))

    // Build A.
    await userEvent.type(screen.getByLabelText(/ask akis/i), 'first app{Enter}')
    await userEvent.click(await screen.findByRole('button', { name: 'Approve & Build' }))
    await waitFor(() => expect(bodies.length).toBe(1))
    expect(bodies[0]).not.toHaveProperty('baseSessionId')
    // ONE run-block now (each run-block renders exactly one Trust ledger).
    await waitFor(() => expect(screen.getAllByLabelText('Trust ledger')).toHaveLength(1))

    // Follow-up CHANGE → Build B. Approve the LATEST spec card.
    await userEvent.type(screen.getAllByLabelText(/ask akis/i)[0]!, 'second app{Enter}')
    const approves = await screen.findAllByRole('button', { name: 'Approve & Build' })
    await userEvent.click(approves[approves.length - 1]!)
    await waitFor(() => expect(bodies.length).toBe(2))
    // The 2nd startSession base-merges the prior (active) run that PRODUCED CODE.
    expect(bodies[1]).toMatchObject({ baseSessionId: 'sA' })

    // TWO run-blocks now live in the SAME scroll (run A is terminal, run B is active) — two ledgers.
    await waitFor(() => expect(screen.getAllByLabelText('Trust ledger').length).toBe(2))

    // Stop targets the LATEST (active) run: the active EmitStream is the last connected one (sB).
    const live = EmitStream.created[EmitStream.created.length - 1]!
    expect(live.connectedUrl).toBe('/sessions/sB/events')
    live.emit(ev({ kind: 'session', status: 'started', sessionId: 'sB' }), 1)
    const stop = await screen.findByRole('button', { name: 'Stop run' })
    await userEvent.click(stop)
    await waitFor(() => expect(cancelRun).toHaveBeenCalledWith('sB'))
    // Exactly the latest — never the older terminal run.
    expect(cancelRun).not.toHaveBeenCalledWith('sA')
  })

  it("reopen seeds ONE run-block + a clean greeting (no inherited chat) and replays its log", async () => {
    EmitStream.created = []
    // Seed an UNRELATED prior conversation; reopening must NOT inherit it.
    localStorage.setItem('akis_chat_thread', JSON.stringify([
      { role: 'user', content: 'unrelated earlier chat' },
      { role: 'assistant', content: 'unrelated earlier reply' },
    ]))
    const fetchFn = vi.fn(async (path: string) => {
      if (path.endsWith('/sessions/mine')) return { ok: true, status: 200, json: async () => ([{ id: 'sR', idea: '# Reopened App', status: 'done', verified: true }]), text: async () => '' } as unknown as Response
      if (path.endsWith('/sessions/sR/log')) return { ok: true, status: 200, json: async () => ({ events: [], head: 0 }), text: async () => '' } as unknown as Response
      if (path.endsWith('/sessions/sR')) return { ok: true, status: 200, json: async () => ({ id: 'sR', status: 'done', version: 1 }), text: async () => '' } as unknown as Response
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response
    })
    const api = new ApiClient('', fetchFn)
    render(wrap(<ChatStudio api={api} makeClient={() => new EmitStream() as unknown as EventStreamClient} />))

    await userEvent.click(await screen.findByRole('button', { name: /History/i }))
    await userEvent.click(await screen.findByRole('menuitem', { name: /Reopened App/i }))

    // Exactly ONE run-block (one trust ledger), titled by the reopened idea; the live stream connects.
    await waitFor(() => expect(screen.getByText('Reopened App')).toBeInTheDocument())
    expect(screen.getAllByLabelText('Trust ledger')).toHaveLength(1)
    await waitFor(() => expect(EmitStream.created.some(s => s.connectedUrl === '/sessions/sR/events')).toBe(true))
    // The CLEAN greeting is present; the unrelated prior chat is NOT inherited.
    expect(screen.getByText(/I’m AKIS/)).toBeInTheDocument()
    expect(screen.queryByText('unrelated earlier chat')).toBeNull()
    expect(screen.queryByText('unrelated earlier reply')).toBeNull()
  })
})
