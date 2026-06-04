import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiClient } from '../api/client.js'
import { AkisChat } from './AkisChat.js'
import { I18nProvider } from '../i18n/I18nContext.js'
import { loadThread } from './akisThread.js'

beforeEach(() => localStorage.clear())

/** A /api/chat fetch double: ok-replies, or a configurable status/body for the error paths. */
function chatFetch(reply: string) {
  return vi.fn(async (path: string) => {
    if (path.endsWith('/api/chat')) return { ok: true, status: 200, json: async () => ({ reply }) } as unknown as Response
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
