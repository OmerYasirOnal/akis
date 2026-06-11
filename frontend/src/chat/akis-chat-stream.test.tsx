import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiClient } from '../api/client.js'
import { AkisChat } from './AkisChat.js'
import { I18nProvider } from '../i18n/I18nContext.js'

beforeEach(() => localStorage.clear())

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

/** A fetch double whose /api/chat/stream body streams the given SSE chunks. */
function streamFetch(chunks: string[]) {
  return vi.fn(async (path: string) => {
    if (path.endsWith('/api/chat/stream')) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder()
          for (const c of chunks) controller.enqueue(enc.encode(c))
          controller.close()
        },
      })
      return { ok: true, status: 200, body, json: async () => ({}) } as unknown as Response
    }
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
  })
}

/** A fetch double: /stream fails (status), /api/chat (non-stream) succeeds with `reply`. */
function streamFailsThenFallback(reply: string) {
  return vi.fn(async (path: string) => {
    if (path.endsWith('/api/chat/stream')) return { ok: false, status: 502, json: async () => ({ error: 'no stream', code: 'ProviderError' }) } as unknown as Response
    if (path.endsWith('/api/chat')) return { ok: true, status: 200, json: async () => ({ reply }) } as unknown as Response
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
  })
}

describe('AkisChat (streaming)', () => {
  it('renders the reply token-by-token (incremental), ending with the full text', async () => {
    const fetchFn = streamFetch([
      frame('delta', { text: 'Hello ' }),
      frame('delta', { text: 'from ' }),
      frame('delta', { text: 'AKIS' }),
      frame('done', { reply: 'Hello from AKIS' }),
    ])
    const api = new ApiClient('', fetchFn)
    render(<I18nProvider><AkisChat api={api} /></I18nProvider>)
    await userEvent.type(screen.getByLabelText(/ask akis/i), 'hi')
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(screen.getByText('Hello from AKIS')).toBeInTheDocument())
    // It used the streaming endpoint.
    expect(fetchFn.mock.calls.some(c => String(c[0]).endsWith('/api/chat/stream'))).toBe(true)
  })

  it('shows the SpecCard once the akis-spec block COMPLETES in the accumulated stream', async () => {
    // Stream the spec in pieces; only the final accumulated text closes the fence.
    const fetchFn = streamFetch([
      frame('delta', { text: "Here's a spec 👇\n```akis-spec\n# TODO App\n" }),
      frame('delta', { text: 'A list.\n' }),
      frame('delta', { text: '```' }),
      frame('done', { reply: "Here's a spec 👇\n```akis-spec\n# TODO App\nA list.\n```" }),
    ])
    const api = new ApiClient('', fetchFn)
    const onBuild = vi.fn()
    render(<I18nProvider><AkisChat api={api} onBuild={onBuild} /></I18nProvider>)
    await userEvent.type(screen.getByLabelText(/ask akis/i), 'spec it')
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(screen.getByText('Build-ready spec')).toBeInTheDocument())
    expect(screen.getByText("Here's a spec 👇")).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Approve & Build' }))
    expect(onBuild).toHaveBeenCalledWith('# TODO App\nA list.')
  })

  it('falls back to the non-stream chatWithAkis path when streaming fails', async () => {
    const fetchFn = streamFailsThenFallback('Recovered via fallback.')
    const api = new ApiClient('', fetchFn)
    render(<I18nProvider><AkisChat api={api} /></I18nProvider>)
    await userEvent.type(screen.getByLabelText(/ask akis/i), 'hi')
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(screen.getByText('Recovered via fallback.')).toBeInTheDocument())
    expect(screen.queryByRole('alert')).toBeNull() // no error row — the fallback recovered
    expect(fetchFn.mock.calls.some(c => String(c[0]).endsWith('/api/chat'))).toBe(true)
  })

  it('shows an error row when BOTH the stream and the fallback fail', async () => {
    const fetchFn = vi.fn(async (path: string) => {
      if (path.endsWith('/api/chat/stream')) return { ok: false, status: 502, json: async () => ({ error: 'boom', code: 'ProviderError' }) } as unknown as Response
      if (path.endsWith('/api/chat')) return { ok: false, status: 502, json: async () => ({ error: 'boom', code: 'ProviderError' }) } as unknown as Response
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
    })
    const api = new ApiClient('', fetchFn)
    render(<I18nProvider><AkisChat api={api} /></I18nProvider>)
    await userEvent.type(screen.getByLabelText(/ask akis/i), 'hi')
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Message failed')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('surfaces an empty streamed reply honestly as an error row', async () => {
    const fetchFn = streamFetch([frame('done', { reply: '   ' })])
    const api = new ApiClient('', fetchFn)
    render(<I18nProvider><AkisChat api={api} /></I18nProvider>)
    await userEvent.type(screen.getByLabelText(/ask akis/i), 'say something')
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/empty reply/i)
  })

  // F1(b) — LIVE DRAFTING SIGNAL. The additive `scribe`/drafting frame lifts a chat-level Scribe
  // presence UP to the parent (onScribeActivity) so the header roster can show Scribe 'working' while
  // drafting and 'done' once the spec card lands — and the in-chat typing cue swaps to "Scribe is
  // drafting…". The frame is NOT a delta and never enters the reply text.
  it('reports Scribe presence UP (working → done) as the drafting frame then the spec arrive', async () => {
    // A controllable stream so the 'working' transition (drafting frame received, spec not yet landed)
    // is a real intermediate render — a fully-synchronous stream would batch straight to 'done'.
    let enqueue!: (s: string) => void
    let close!: () => void
    const fetchFn = vi.fn(async (path: string) => {
      if (path.endsWith('/api/chat/stream')) {
        const enc = new TextEncoder()
        const body = new ReadableStream<Uint8Array>({
          start(c) { enqueue = (s: string) => c.enqueue(enc.encode(s)); close = () => c.close() },
        })
        return { ok: true, status: 200, body, json: async () => ({}) } as unknown as Response
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
    })
    const api = new ApiClient('', fetchFn)
    const presence: string[] = []
    render(<I18nProvider><AkisChat api={api} onBuild={() => {}} onScribeActivity={p => presence.push(p)} /></I18nProvider>)
    await userEvent.type(screen.getByLabelText(/ask akis/i), 'build it')
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))
    enqueue(frame('delta', { text: "Here's a spec 👇\n" }))
    enqueue(frame('scribe', { scribe: 'drafting' }))
    await waitFor(() => expect(presence).toContain('working')) // drafting started → 'working'
    enqueue(frame('delta', { text: '```akis-spec\n# TODO App\nA list.\n```' }))
    enqueue(frame('done', { reply: "Here's a spec 👇\n```akis-spec\n# TODO App\nA list.\n```" }))
    close()
    await waitFor(() => expect(screen.getByText('Build-ready spec')).toBeInTheDocument())
    // Ends on 'done' (the spec card is present pre-build).
    expect(presence[presence.length - 1]).toBe('done')
  })

  it('an ordinary turn (no spec) never lifts a Scribe presence other than idle', async () => {
    const fetchFn = streamFetch([frame('delta', { text: 'Just chatting.' }), frame('done', { reply: 'Just chatting.' })])
    const api = new ApiClient('', fetchFn)
    const presence: string[] = []
    render(<I18nProvider><AkisChat api={api} onBuild={() => {}} onScribeActivity={p => presence.push(p)} /></I18nProvider>)
    await userEvent.type(screen.getByLabelText(/ask akis/i), 'hi')
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(screen.getByText('Just chatting.')).toBeInTheDocument())
    expect(presence.every(p => p === 'idle')).toBe(true)
  })

  it('shows the "Scribe is drafting…" status (not the generic cue) while a real Scribe call runs', async () => {
    // A controllable stream: emit the drafting frame, then PAUSE — so the drafting status is observable
    // before the spec/done lands. The generic cue must NOT be shown during the drafting window.
    let enqueue!: (s: string) => void
    let close!: () => void
    const fetchFn = vi.fn(async (path: string) => {
      if (path.endsWith('/api/chat/stream')) {
        const enc = new TextEncoder()
        const body = new ReadableStream<Uint8Array>({
          start(c) { enqueue = (s: string) => c.enqueue(enc.encode(s)); close = () => c.close() },
        })
        return { ok: true, status: 200, body, json: async () => ({}) } as unknown as Response
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
    })
    const api = new ApiClient('', fetchFn)
    render(<I18nProvider><AkisChat api={api} onBuild={() => {}} /></I18nProvider>)
    await userEvent.type(screen.getByLabelText(/ask akis/i), 'build it')
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))
    enqueue(frame('delta', { text: 'Handing off… ' }))
    enqueue(frame('scribe', { scribe: 'drafting' }))
    await waitFor(() => expect(screen.getByText('Scribe is drafting the spec…')).toBeInTheDocument())
    expect(screen.queryByText('AKIS is thinking…')).toBeNull()
    enqueue(frame('done', { reply: 'Handing off… ' }))
    close()
    await waitFor(() => expect(screen.queryByText('Scribe is drafting the spec…')).toBeNull())
  })

  it('EXCLUDES error rows + the in-flight placeholder from the next send history', async () => {
    let attempt = 0
    const fetchFn = vi.fn(async (path: string, _init?: RequestInit) => {
      if (path.endsWith('/api/chat/stream')) {
        attempt++
        if (attempt === 1) return { ok: false, status: 502, json: async () => ({ error: 'boom', code: 'ProviderError' }) } as unknown as Response
        // Second send streams ok.
        const body = new ReadableStream<Uint8Array>({
          start(c) { const e = new TextEncoder(); c.enqueue(e.encode(frame('delta', { text: 'ok now' }) + frame('done', { reply: 'ok now' }))); c.close() },
        })
        return { ok: true, status: 200, body, json: async () => ({}) } as unknown as Response
      }
      if (path.endsWith('/api/chat')) return { ok: false, status: 502, json: async () => ({ error: 'boom', code: 'ProviderError' }) } as unknown as Response
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
    })
    const api = new ApiClient('', fetchFn)
    render(<I18nProvider><AkisChat api={api} /></I18nProvider>)
    await userEvent.type(screen.getByLabelText(/ask akis/i), 'first q')
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))
    await screen.findByRole('alert')
    await userEvent.type(screen.getByLabelText(/ask akis/i), 'second q')
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(screen.getByText('ok now')).toBeInTheDocument())

    const streamCalls = fetchFn.mock.calls.filter(c => String(c[0]).endsWith('/api/chat/stream'))
    const secondBody = JSON.parse(String(streamCalls[1]![1]?.body)) as { history: { role: string; content: string }[] }
    expect(secondBody.history.every(m => m.role === 'user' || m.role === 'assistant')).toBe(true)
    expect(secondBody.history.some(m => /boom|Message failed/.test(m.content))).toBe(false)
  })
})
