import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiClient } from '../api/client.js'
import { AkisChat } from './AkisChat.js'
import { I18nProvider } from '../i18n/I18nContext.js'
import { MODEL_PREF_KEY } from './modelPref.js'

beforeEach(() => localStorage.clear())

const PROVIDERS = [
  {
    id: 'anthropic', label: 'Anthropic (Claude)', available: true, defaultModel: 'claude-haiku-4-5-20251001',
    models: [
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', recommended: true },
    ],
  },
]

/** A fetch double that serves /api/providers + /health, and answers /api/chat with `reply`.
 *  The non-stream /api/chat path is exercised (no body on /api/chat/stream → it 404s → fallback). */
function modelFetch(reply: string, mode: 'live' | 'demo' = 'live') {
  return vi.fn(async (path: string, _init?: RequestInit) => {
    if (path.endsWith('/api/providers')) return { ok: true, status: 200, json: async () => PROVIDERS } as unknown as Response
    if (path.endsWith('/health')) return { ok: true, status: 200, json: async () => ({ ok: true, persistence: 'memory', mode }) } as unknown as Response
    if (path.endsWith('/api/chat')) return { ok: true, status: 200, json: async () => ({ reply }) } as unknown as Response
    // /api/chat/stream not modeled → 404 so AkisChat falls back to /api/chat (still carries overrides).
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
  })
}

describe('AkisChat — model picker (chat-only visibility + selection)', () => {
  it('renders the model chip once providers + health load (shows the active model + mode)', async () => {
    const api = new ApiClient('', modelFetch('hi', 'live'))
    render(<I18nProvider><AkisChat api={api} /></I18nProvider>)
    // The chip seeds from the first provider's defaultModel.
    const chip = await screen.findByRole('button', { name: /active model/i })
    expect(chip).toHaveTextContent('Anthropic (Claude)')
    expect(chip).toHaveTextContent('Claude Haiku 4.5')
    expect(chip).toHaveTextContent('LIVE')
  })

  it('shows a DEMO badge when /health reports demo mode', async () => {
    const api = new ApiClient('', modelFetch('hi', 'demo'))
    render(<I18nProvider><AkisChat api={api} /></I18nProvider>)
    const chip = await screen.findByRole('button', { name: /active model/i })
    expect(chip).toHaveTextContent('DEMO')
  })

  it('restores the saved preference from localStorage (initial chip reflects it)', async () => {
    localStorage.setItem(MODEL_PREF_KEY, JSON.stringify({ provider: 'anthropic', model: 'claude-sonnet-4-6', effort: 'deep' }))
    const api = new ApiClient('', modelFetch('hi'))
    render(<I18nProvider><AkisChat api={api} /></I18nProvider>)
    const chip = await screen.findByRole('button', { name: /active model/i })
    expect(chip).toHaveTextContent('Claude Sonnet 4.6')
    expect(chip).toHaveTextContent('Deep')
  })

  it('does NOT throw on corrupt localStorage JSON (degrades to default)', async () => {
    localStorage.setItem(MODEL_PREF_KEY, 'broken{json')
    const api = new ApiClient('', modelFetch('hi'))
    expect(() => render(<I18nProvider><AkisChat api={api} /></I18nProvider>)).not.toThrow()
    const chip = await screen.findByRole('button', { name: /active model/i })
    expect(chip).toHaveTextContent('Balanced') // default effort
  })

  it('opens the picker, applies a new model, persists it to localStorage, and updates the chip', async () => {
    const api = new ApiClient('', modelFetch('hi'))
    render(<I18nProvider><AkisChat api={api} /></I18nProvider>)
    await userEvent.click(await screen.findByRole('button', { name: /active model/i }))
    // Picker is open.
    await userEvent.click(await screen.findByRole('radio', { name: 'Claude Sonnet 4.6' }))
    await userEvent.click(screen.getByRole('radio', { name: /Deep/i }))
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }))
    // Persisted.
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem(MODEL_PREF_KEY) ?? '{}')
      expect(saved).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-4-6', effort: 'deep' })
    })
    // Chip updated.
    const chip = screen.getByRole('button', { name: /active model/i })
    expect(chip).toHaveTextContent('Claude Sonnet 4.6')
    expect(chip).toHaveTextContent('Deep')
  })

  it('sends {provider, model, effort} in the chat request body (chat-only override)', async () => {
    localStorage.setItem(MODEL_PREF_KEY, JSON.stringify({ provider: 'anthropic', model: 'claude-sonnet-4-6', effort: 'fast' }))
    const fetchFn = modelFetch('done')
    const api = new ApiClient('', fetchFn)
    render(<I18nProvider><AkisChat api={api} /></I18nProvider>)
    await screen.findByRole('button', { name: /active model/i })
    await userEvent.type(screen.getByLabelText(/ask akis/i), 'hello')
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(screen.getByText('done')).toBeInTheDocument())

    // The /api/chat call body must carry the overrides.
    const chatCall = fetchFn.mock.calls.find(c => String(c[0]).endsWith('/api/chat'))!
    const body = JSON.parse(String(chatCall[1]?.body)) as Record<string, unknown>
    expect(body).toMatchObject({ message: 'hello', provider: 'anthropic', model: 'claude-sonnet-4-6', effort: 'fast' })
  })

  it('omits provider/model when the pref is the AKIS default (byte-identical request)', async () => {
    // No saved pref → provider seeds from catalog; clear it to the empty default to assert omission.
    const fetchFn = vi.fn(async (path: string, _init?: RequestInit) => {
      if (path.endsWith('/api/providers')) return { ok: true, status: 200, json: async () => [] } as unknown as Response // empty → no seed
      if (path.endsWith('/health')) return { ok: true, status: 200, json: async () => ({ ok: true, persistence: 'memory', mode: 'live' }) } as unknown as Response
      if (path.endsWith('/api/chat')) return { ok: true, status: 200, json: async () => ({ reply: 'ok' }) } as unknown as Response
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
    })
    const api = new ApiClient('', fetchFn)
    render(<I18nProvider><AkisChat api={api} /></I18nProvider>)
    await userEvent.type(screen.getByLabelText(/ask akis/i), 'hi')
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(screen.getByText('ok')).toBeInTheDocument())
    const chatCall = fetchFn.mock.calls.find(c => String(c[0]).endsWith('/api/chat'))!
    const body = JSON.parse(String(chatCall[1]?.body)) as Record<string, unknown>
    expect(body).not.toHaveProperty('provider')
    expect(body).not.toHaveProperty('model')
    // Effort is always present (it always maps to a budget); balanced is the default.
    expect(body.effort).toBe('balanced')
  })

  it('SACRED: builds (onBuild → startSession) NEVER receive {provider, model, effort}', async () => {
    // Reply carries an akis-spec block so a SpecCard renders; Approve triggers onBuild.
    const reply = "Spec 👇\n```akis-spec\n# TODO\nA list.\n```"
    localStorage.setItem(MODEL_PREF_KEY, JSON.stringify({ provider: 'anthropic', model: 'claude-sonnet-4-6', effort: 'deep' }))
    const api = new ApiClient('', modelFetch(reply))
    const onBuild = vi.fn()
    render(<I18nProvider><AkisChat api={api} onBuild={onBuild} /></I18nProvider>)
    await screen.findByRole('button', { name: /active model/i })
    await userEvent.type(screen.getByLabelText(/ask akis/i), 'spec it')
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Approve & Build' }))
    // onBuild receives ONLY the spec string — no model-pref object/fields leak into the build.
    expect(onBuild).toHaveBeenCalledTimes(1)
    expect(onBuild).toHaveBeenCalledWith('# TODO\nA list.')
    const arg = onBuild.mock.calls[0]![0]
    expect(typeof arg).toBe('string')
    expect(JSON.stringify(onBuild.mock.calls[0])).not.toMatch(/claude-sonnet-4-6|"effort"|"deep"/)
  })
})
