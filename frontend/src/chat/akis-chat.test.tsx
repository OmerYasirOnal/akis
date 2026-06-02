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
})
