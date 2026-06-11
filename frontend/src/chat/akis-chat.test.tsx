import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiClient } from '../api/client.js'
import { AkisChat } from './AkisChat.js'
import { I18nProvider } from '../i18n/I18nContext.js'
import { loadThread, saveThread } from './akisThread.js'

beforeEach(() => localStorage.clear())

/** A /api/chat fetch double: ok-replies, or a configurable status/body for the error paths. */
function chatFetch(reply: string) {
  return vi.fn(async (path: string) => {
    if (path.endsWith('/api/chat')) return { ok: true, status: 200, json: async () => ({ reply }) } as unknown as Response
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
  })
}

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

/** A fetch double whose /api/chat/stream body streams the given SSE chunks (one-shot). */
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

describe('AkisChat', () => {
  it('shows the AKIS greeting and replies to the user via /api/chat', async () => {
    const api = new ApiClient('', chatFetch('Sure — tell me the app and hit Build.'))
    render(<I18nProvider><AkisChat api={api} /></I18nProvider>)

    expect(screen.getByText(/I’m AKIS/)).toBeInTheDocument() // greeting
    await userEvent.type(screen.getByLabelText(/ask akis/i), 'what can you build?')
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))

    await waitFor(() => expect(screen.getByText('Sure — tell me the app and hit Build.')).toBeInTheDocument())
    expect(screen.getByText('what can you build?')).toBeInTheDocument() // user bubble
  })

  it('renders markdown in a reply (no literal ** or ---)', async () => {
    const api = new ApiClient('', chatFetch('A **bold** plan.'))
    render(<I18nProvider><AkisChat api={api} /></I18nProvider>)
    await userEvent.type(screen.getByLabelText(/ask akis/i), 'plan it')
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(screen.getByText('bold').tagName).toBe('STRONG'))
  })

  it('shows a SpecCard when a reply carries an akis-spec block; Approve → onBuild', async () => {
    const reply = "Here's a spec 👇\n```akis-spec\n# TODO App\nA list.\n```"
    const api = new ApiClient('', chatFetch(reply))
    const onBuild = vi.fn()
    render(<I18nProvider><AkisChat api={api} onBuild={onBuild} /></I18nProvider>)
    await userEvent.type(screen.getByLabelText(/ask akis/i), 'give me a spec')
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))

    await waitFor(() => expect(screen.getByText('Build-ready spec')).toBeInTheDocument())
    expect(screen.getByText("Here's a spec 👇")).toBeInTheDocument() // intro rendered
    await userEvent.click(screen.getByRole('button', { name: 'Approve & Build' }))
    expect(onBuild).toHaveBeenCalledWith('# TODO App\nA list.')
  })

  it('the build-ready spec message is presented AS Scribe (Sc avatar + "Scribe" name), not AKIS', async () => {
    // P2: the spec belongs to Scribe's identity in the UI even though the chat-seeded build skips
    // the Scribe pipeline agent. The spec-card assistant message gets the Sc monogram + a "Scribe"
    // name label; the greeting (a plain assistant message) keeps the AK monogram.
    const reply = "Here's a spec 👇\n```akis-spec\n# TODO App\nA list.\n```"
    const api = new ApiClient('', chatFetch(reply))
    render(<I18nProvider><AkisChat api={api} onBuild={() => {}} /></I18nProvider>)
    await userEvent.type(screen.getByLabelText(/ask akis/i), 'give me a spec')
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))

    await waitFor(() => expect(screen.getByText('Build-ready spec')).toBeInTheDocument())
    // The spec card carries Scribe's identity: a "Scribe" name label + the "Sc" role monogram.
    expect(screen.getByText('Scribe')).toBeInTheDocument()
    expect(screen.getByText('Sc')).toBeInTheDocument()
    // The greeting (a non-spec assistant message) still renders as AKIS.
    expect(screen.getByText('AK')).toBeInTheDocument()
  })

  it('a plain (non-spec) assistant reply stays AKIS (AK) — no Scribe identity leaks onto ordinary chat', async () => {
    const api = new ApiClient('', chatFetch('Just chatting, no spec.'))
    render(<I18nProvider><AkisChat api={api} onBuild={() => {}} /></I18nProvider>)
    await userEvent.type(screen.getByLabelText(/ask akis/i), 'hi')
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(screen.getByText('Just chatting, no spec.')).toBeInTheDocument())
    // No spec → no Scribe name label / Sc monogram anywhere; AKIS (AK) avatars only.
    expect(screen.queryByText('Scribe')).toBeNull()
    expect(screen.queryByText('Sc')).toBeNull()
    expect(screen.getAllByText('AK').length).toBeGreaterThan(0)
  })

  it('shows NO SpecCard for a plain reply', async () => {
    const api = new ApiClient('', chatFetch('Just chatting, no spec.'))
    render(<I18nProvider><AkisChat api={api} onBuild={() => {}} /></I18nProvider>)
    await userEvent.type(screen.getByLabelText(/ask akis/i), 'hi')
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(screen.getByText('Just chatting, no spec.')).toBeInTheDocument())
    expect(screen.queryByText('Build-ready spec')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Approve & Build' })).toBeNull()
  })

  // ── Resilience: distinct error rows + retry + history exclusion ──

  it('renders a provider 502 as a DISTINCT error row (role=alert), not a faked AK reply', async () => {
    const fetchFn = vi.fn(async (path: string) => {
      if (path.endsWith('/api/chat')) return { ok: false, status: 502, json: async () => ({ error: 'upstream down', code: 'ProviderError' }) } as unknown as Response
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
    })
    const api = new ApiClient('', fetchFn)
    render(<I18nProvider><AkisChat api={api} /></I18nProvider>)
    await userEvent.type(screen.getByLabelText(/ask akis/i), 'hello?')
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Message failed')
    expect(alert).toHaveTextContent(/ProviderError/)
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    // The error must NOT masquerade as an AK chat bubble.
    expect(screen.queryByText(/upstream down/)?.closest('[role="alert"]')).not.toBeNull()
  })

  it('renders a network failure as an error row with a friendly message', async () => {
    const fetchFn = vi.fn(async (path: string) => {
      if (path.endsWith('/api/chat')) throw new TypeError('Failed to fetch')
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
    })
    const api = new ApiClient('', fetchFn)
    render(<I18nProvider><AkisChat api={api} /></I18nProvider>)
    await userEvent.type(screen.getByLabelText(/ask akis/i), 'ping')
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/Couldn’t reach AKIS/)
  })

  it('surfaces an empty reply honestly as an error row (not a real answer)', async () => {
    const api = new ApiClient('', chatFetch('   '))
    render(<I18nProvider><AkisChat api={api} /></I18nProvider>)
    await userEvent.type(screen.getByLabelText(/ask akis/i), 'say something')
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/empty reply/i)
  })

  it('Retry resends the LAST user message and clears the error on success', async () => {
    let attempt = 0
    const fetchFn = vi.fn(async (path: string) => {
      if (path.endsWith('/api/chat')) {
        attempt++
        if (attempt === 1) return { ok: false, status: 502, json: async () => ({ error: 'boom', code: 'ProviderError' }) } as unknown as Response
        return { ok: true, status: 200, json: async () => ({ reply: 'Recovered! Hit Build.' }) } as unknown as Response
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
    })
    const api = new ApiClient('', fetchFn)
    render(<I18nProvider><AkisChat api={api} /></I18nProvider>)
    await userEvent.type(screen.getByLabelText(/ask akis/i), 'build a todo')
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))
    await screen.findByRole('alert')

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByText('Recovered! Hit Build.')).toBeInTheDocument())
    expect(screen.queryByRole('alert')).toBeNull() // stale error dropped
    // Exactly one user bubble — Retry did NOT add a second one.
    expect(screen.getAllByText('build a todo')).toHaveLength(1)
  })

  it('EXCLUDES the error row from the history sent on the NEXT send (no context poisoning)', async () => {
    let attempt = 0
    const fetchFn = vi.fn(async (path: string, _init?: RequestInit) => {
      if (path.endsWith('/api/chat')) {
        attempt++
        if (attempt === 1) return { ok: false, status: 502, json: async () => ({ error: 'boom', code: 'ProviderError' }) } as unknown as Response
        return { ok: true, status: 200, json: async () => ({ reply: 'ok now' }) } as unknown as Response
      }
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

    // The 2nd /api/chat body must carry no 'error' role and no error string in its history.
    const secondCall = fetchFn.mock.calls.filter(c => String(c[0]).endsWith('/api/chat'))[1]!
    const body = JSON.parse(String(secondCall[1]?.body)) as { history: { role: string; content: string }[] }
    expect(body.history.every(m => m.role === 'user' || m.role === 'assistant')).toBe(true)
    expect(body.history.some(m => /boom|Message failed/.test(m.content))).toBe(false)
  })

  it('clears onUnauthorized-style 401 with a brief notice row', async () => {
    const fetchFn = vi.fn(async (path: string) => {
      if (path.endsWith('/api/chat')) return { ok: false, status: 401, json: async () => ({ error: 'Unauthorized', code: 'Unauthorized' }) } as unknown as Response
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
    })
    const api = new ApiClient('', fetchFn)
    const onUnauthorized = vi.fn()
    api.onUnauthorized = onUnauthorized
    render(<I18nProvider><AkisChat api={api} /></I18nProvider>)
    await userEvent.type(screen.getByLabelText(/ask akis/i), 'hi')
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/session expired/i)
    expect(onUnauthorized).toHaveBeenCalledTimes(1) // ApiClient fired the global handler
  })

  it('renders a 429 QuotaExceeded chat error as the localized quota row (not a faked reply)', async () => {
    const fetchFn = vi.fn(async (path: string) => {
      if (path.endsWith('/api/chat')) return { ok: false, status: 429, json: async () => ({ error: 'token quota exceeded', code: 'QuotaExceeded', resetAt: '2026-07-01T00:00:00.000Z' }) } as unknown as Response
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
    })
    const api = new ApiClient('', fetchFn)
    render(<I18nProvider><AkisChat api={api} /></I18nProvider>)
    await userEvent.type(screen.getByLabelText(/ask akis/i), 'build a lot')
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/token quota/i) // the localized quota sentence
    expect(alert).toHaveTextContent('Message failed') // a real error row, not an AK bubble
  })

  it('a stream-path 429 renders the quota row WITHOUT a redundant non-stream /api/chat call', async () => {
    // The stream endpoint pre-hijack-429s; the client throws ApiError(429,'QuotaExceeded'). The
    // catch must short-circuit (like 401) and NOT re-call /api/chat (a second blocked request).
    const fetchFn = vi.fn(async (path: string) => {
      if (path.endsWith('/api/chat/stream')) return { ok: false, status: 429, json: async () => ({ error: 'token quota exceeded', code: 'QuotaExceeded', resetAt: '2026-07-01T00:00:00.000Z' }) } as unknown as Response
      if (path.endsWith('/api/chat')) return { ok: true, status: 200, json: async () => ({ reply: 'should NOT be called' }) } as unknown as Response
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
    })
    const api = new ApiClient('', fetchFn)
    render(<I18nProvider><AkisChat api={api} /></I18nProvider>)
    await userEvent.type(screen.getByLabelText(/ask akis/i), 'go')
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/token quota/i)
    // The non-stream /api/chat fallback must NOT have fired (the 429 short-circuit removes it).
    expect(fetchFn.mock.calls.filter(c => String(c[0]).endsWith('/api/chat'))).toHaveLength(0)
  })

  it('shows a truncated-spec notice when an akis-spec fence opened but never closed', async () => {
    const reply = "Here's your spec 👇\n````akis-spec\n# Big App\nlots of detail that got cut off"
    const api = new ApiClient('', chatFetch(reply))
    render(<I18nProvider><AkisChat api={api} onBuild={() => {}} /></I18nProvider>)
    await userEvent.type(screen.getByLabelText(/ask akis/i), 'spec it')
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(screen.getByText(/cut off before it finished/i)).toBeInTheDocument())
    expect(screen.queryByText('Build-ready spec')).toBeNull() // no Build card for a partial spec
  })

  // ── Persistence + a11y ──

  it('persists the thread to localStorage so it survives a remount (build start / reload)', async () => {
    const api = new ApiClient('', chatFetch('Persisted reply.'))
    const { unmount } = render(<I18nProvider><AkisChat api={api} /></I18nProvider>)
    await userEvent.type(screen.getByLabelText(/ask akis/i), 'remember this')
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(screen.getByText('Persisted reply.')).toBeInTheDocument())

    const saved = loadThread()
    expect(saved.some(m => m.role === 'user' && m.content === 'remember this')).toBe(true)
    expect(saved.some(m => m.role === 'assistant' && m.content === 'Persisted reply.')).toBe(true)

    // Simulate the build-start unmount + a fresh mount (reload): the thread is restored.
    unmount()
    render(<I18nProvider><AkisChat api={api} /></I18nProvider>)
    expect(screen.getByText('remember this')).toBeInTheDocument()
    expect(screen.getByText('Persisted reply.')).toBeInTheDocument()
  })

  it('autofocuses the composer and marks the message region/composer for a11y', async () => {
    const api = new ApiClient('', chatFetch('x'))
    const { container } = render(<I18nProvider><AkisChat api={api} /></I18nProvider>)
    expect(screen.getByLabelText(/ask akis/i)).toHaveFocus()
    expect(container.querySelector('[aria-live="polite"]')).not.toBeNull()
    expect(container.querySelector('form')).toHaveAttribute('aria-busy', 'false')
  })
})

// ── Streaming text smoothing (useSmoothText) ──
// The reveal is governed by the smoothing hook. With prefers-reduced-motion mocked ON, the
// hook sets text instantly (deterministic) — perfect for asserting the END STATE without
// racing rAF. We also assert that the streamed message FINALIZES into a completed bubble and
// that spec detection runs on the FULL accumulated content (never the animated slice).
describe('AkisChat — streaming text smoothing', () => {
  beforeEach(() => {
    // Reduced-motion ON → useSmoothText mirrors the full text immediately. This keeps the
    // assertions deterministic (no rAF timing races) while still exercising the hook path.
    window.matchMedia = vi.fn((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia
  })

  it('finalizes a streamed reply into a completed bubble showing the full text', async () => {
    const fetchFn = streamFetch([
      frame('delta', { text: 'Smoothly ' }),
      frame('delta', { text: 'revealed ' }),
      frame('delta', { text: 'reply.' }),
      frame('done', { reply: 'Smoothly revealed reply.' }),
    ])
    const api = new ApiClient('', fetchFn)
    render(<I18nProvider><AkisChat api={api} /></I18nProvider>)
    await userEvent.type(screen.getByLabelText(/ask akis/i), 'hi')
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))
    // After finalize(), the streaming placeholder is gone and a completed bubble shows the full text.
    await waitFor(() => expect(screen.getByText('Smoothly revealed reply.')).toBeInTheDocument())
    // The completed message is persisted with NO streaming flag (finalize added a clean one).
    expect(loadThread().some(m => m.role === 'assistant' && m.content === 'Smoothly revealed reply.')).toBe(true)
  })

  it('detects a spec on the FULL accumulated content even while the reply animates', async () => {
    const reply = "Here's a spec 👇\n```akis-spec\n# TODO App\nA list.\n```"
    const fetchFn = streamFetch([
      frame('delta', { text: "Here's a spec 👇\n```akis-spec\n# TODO App\n" }),
      frame('delta', { text: 'A list.\n```' }),
      frame('done', { reply }),
    ])
    const api = new ApiClient('', fetchFn)
    const onBuild = vi.fn()
    render(<I18nProvider><AkisChat api={api} onBuild={onBuild} /></I18nProvider>)
    await userEvent.type(screen.getByLabelText(/ask akis/i), 'spec it')
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))
    // Spec detection runs on m.content (full text), so the SpecCard + intro appear, and Approve
    // hands the EXACT spec to onBuild — proving extraction never used the animated slice.
    await waitFor(() => expect(screen.getByText('Build-ready spec')).toBeInTheDocument())
    expect(screen.getByText("Here's a spec 👇")).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Approve & Build' }))
    expect(onBuild).toHaveBeenCalledWith('# TODO App\nA list.')
  })

  it('renders a completed/history message with full text instantly (no animation gating)', async () => {
    // Seed a completed (non-streaming) assistant message via the real persistence, then mount.
    saveThread([
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'A fully completed answer from history.' },
    ])
    const api = new ApiClient('', chatFetch('unused'))
    render(<I18nProvider><AkisChat api={api} /></I18nProvider>)
    // No streaming flag on a history message → it shows the full text immediately on first render.
    expect(screen.getByText('A fully completed answer from history.')).toBeInTheDocument()
  })

  it('shows the full reply (reduced-motion path) without dropping suggestion chips', async () => {
    const reply = "Pick one:\n```akis-suggest\n- Build a TODO app\n- Build a poll\n```"
    const fetchFn = streamFetch([frame('done', { reply })])
    const api = new ApiClient('', fetchFn)
    render(<I18nProvider><AkisChat api={api} /></I18nProvider>)
    await userEvent.type(screen.getByLabelText(/ask akis/i), 'options?')
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))
    // The intro renders (animated text == full under reduced motion) and the suggestion block is
    // stripped from prose AND surfaced as chips — extraction ran on the full content, not the slice.
    await waitFor(() => expect(screen.getByText('Pick one:')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Build a TODO app' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Build a poll' })).toBeInTheDocument()
    // The raw fence marker must never render as prose.
    expect(screen.queryByText(/akis-suggest/)).toBeNull()
  })
})

describe('AkisChat cold-start starter prompts', () => {
  const STARTER1 = 'A habit tracker with daily streaks and reminders'

  it('offers tappable starter prompts on a fresh thread (just the greeting, no active build)', () => {
    const api = new ApiClient('', chatFetch('ok'))
    render(<I18nProvider><AkisChat api={api} /></I18nProvider>)
    expect(screen.getByText('Not sure where to start? Try one of these:')).toBeInTheDocument()
    // all four example builds render as buttons that the user can tap directly
    expect(screen.getByRole('button', { name: STARTER1 })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'A URL shortener with click analytics' })).toBeInTheDocument()
  })

  it('tapping a starter sends it directly (no typing) and then the starters disappear', async () => {
    const api = new ApiClient('', chatFetch('Great — let’s build it.'))
    render(<I18nProvider><AkisChat api={api} /></I18nProvider>)
    await userEvent.click(screen.getByRole('button', { name: STARTER1 }))
    // the tapped prompt becomes the user message...
    await waitFor(() => expect(screen.getByText('Great — let’s build it.')).toBeInTheDocument())
    expect(screen.getByText(STARTER1)).toBeInTheDocument() // user bubble
    // ...and once the thread has moved past the lone greeting, the starters are gone
    expect(screen.queryByText('Not sure where to start? Try one of these:')).toBeNull()
    expect(screen.queryByRole('button', { name: STARTER1 })).toBeNull()
  })

  it('does NOT show starters once a build is active (activeSessionId set)', () => {
    const api = new ApiClient('', chatFetch('ok'))
    render(<I18nProvider><AkisChat api={api} activeSessionId="s1" /></I18nProvider>)
    expect(screen.queryByText('Not sure where to start? Try one of these:')).toBeNull()
    expect(screen.queryByRole('button', { name: STARTER1 })).toBeNull()
  })
})
