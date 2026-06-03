import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiClient } from '../api/client.js'
import { AkisChat } from './AkisChat.js'
import { I18nProvider } from '../i18n/I18nContext.js'

describe('AkisChat', () => {
  it('shows the AKIS greeting and replies to the user via /api/chat', async () => {
    const fetchFn = vi.fn(async (path: string) => {
      if (path.endsWith('/api/chat')) return { ok: true, status: 200, json: async () => ({ reply: 'Sure — tell me the app and hit Build.' }) } as unknown as Response
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
    })
    const api = new ApiClient('', fetchFn)
    render(<I18nProvider><AkisChat api={api} /></I18nProvider>)

    expect(screen.getByText(/I’m AKIS/)).toBeInTheDocument() // greeting
    await userEvent.type(screen.getByLabelText('ask-akis'), 'what can you build?')
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))

    await waitFor(() => expect(screen.getByText('Sure — tell me the app and hit Build.')).toBeInTheDocument())
    expect(screen.getByText('what can you build?')).toBeInTheDocument() // user bubble
    expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('/api/chat'), expect.objectContaining({ method: 'POST' }))
  })

  it('renders markdown in a reply (no literal ** or ---)', async () => {
    const fetchFn = vi.fn(async (path: string) => {
      if (path.endsWith('/api/chat')) return { ok: true, status: 200, json: async () => ({ reply: 'A **bold** plan.' }) } as unknown as Response
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
    })
    const api = new ApiClient('', fetchFn)
    render(<I18nProvider><AkisChat api={api} /></I18nProvider>)
    await userEvent.type(screen.getByLabelText('ask-akis'), 'plan it')
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(screen.getByText('bold').tagName).toBe('STRONG'))
  })

  it('shows a SpecCard when a reply carries an akis-spec block; Approve → onBuild', async () => {
    const reply = "Here's a spec 👇\n```akis-spec\n# TODO App\nA list.\n```"
    const fetchFn = vi.fn(async (path: string) => {
      if (path.endsWith('/api/chat')) return { ok: true, status: 200, json: async () => ({ reply }) } as unknown as Response
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
    })
    const api = new ApiClient('', fetchFn)
    const onBuild = vi.fn()
    render(<I18nProvider><AkisChat api={api} onBuild={onBuild} /></I18nProvider>)
    await userEvent.type(screen.getByLabelText('ask-akis'), 'give me a spec')
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))

    await waitFor(() => expect(screen.getByText('Build-ready spec')).toBeInTheDocument())
    expect(screen.getByText("Here's a spec 👇")).toBeInTheDocument() // intro rendered
    await userEvent.click(screen.getByRole('button', { name: 'Approve & Build' }))
    expect(onBuild).toHaveBeenCalledWith('# TODO App\nA list.')
  })

  it('shows NO SpecCard for a plain reply', async () => {
    const fetchFn = vi.fn(async (path: string) => {
      if (path.endsWith('/api/chat')) return { ok: true, status: 200, json: async () => ({ reply: 'Just chatting, no spec.' }) } as unknown as Response
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
    })
    const api = new ApiClient('', fetchFn)
    render(<I18nProvider><AkisChat api={api} onBuild={() => {}} /></I18nProvider>)
    await userEvent.type(screen.getByLabelText('ask-akis'), 'hi')
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(screen.getByText('Just chatting, no spec.')).toBeInTheDocument())
    expect(screen.queryByText('Build-ready spec')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Approve & Build' })).toBeNull()
  })
})
