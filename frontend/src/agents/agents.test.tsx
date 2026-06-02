import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderHook } from '@testing-library/react'
import { AgentsTab } from './AgentsTab.js'
import { I18nProvider, useI18n } from '../i18n/I18nContext.js'
import { ApiClient, type ProviderInfo } from '../api/client.js'
import type { ReactNode } from 'react'

const PROVIDERS: ProviderInfo[] = [
  { id: 'anthropic', label: 'Anthropic (Claude)', available: true, defaultModel: 'claude-haiku-4-5-20251001', models: [{ id: 'claude-opus-4-8', label: 'Claude Opus 4.8' }, { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' }] },
]

function apiWith(save = vi.fn(async (i: unknown) => i)): ApiClient {
  const fetchFn = vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/api/providers')) return { ok: true, status: 200, json: async () => PROVIDERS, text: async () => '' } as unknown as Response
    if (path.endsWith('/api/workflows') && init?.method === 'POST') { const body = JSON.parse(init.body as string); await save(body); return { ok: true, status: 201, json: async () => ({ ...body, id: 'w1', version: 1 }), text: async () => '' } as unknown as Response }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response
  })
  return new ApiClient('', fetchFn)
}

const wrap = (ui: ReactNode) => <I18nProvider>{ui}</I18nProvider>

describe('useI18n', () => {
  it('returns EN by default and TR after switch', () => {
    const { result } = renderHook(() => useI18n(), { wrapper: ({ children }) => <I18nProvider>{children}</I18nProvider> })
    expect(result.current.t('tab.agents')).toBe('Agents & Workflows')
  })
  it('serves the TR catalogue', () => {
    const { result } = renderHook(() => useI18n(), { wrapper: ({ children }) => <I18nProvider initial="tr">{children}</I18nProvider> })
    expect(result.current.t('tab.agents')).toBe('Ajanlar & İş Akışları')
  })
})

describe('AgentsTab', () => {
  it('renders the core roster with provider/model pickers from /api/providers', async () => {
    render(wrap(<AgentsTab api={apiWith()} />))
    await waitFor(() => expect(screen.getByText('scribe')).toBeInTheDocument())
    for (const role of ['orchestrator', 'scribe', 'proto', 'trace', 'critic']) expect(screen.getByText(role)).toBeInTheDocument()
    expect(screen.getByLabelText('scribe-provider')).toBeInTheDocument()
  })

  it('saves a workflow with the per-agent model selection', async () => {
    const save = vi.fn(async (i: unknown) => i)
    render(wrap(<AgentsTab api={apiWith(save)} />))
    await waitFor(() => screen.getByLabelText('scribe-provider'))
    await userEvent.selectOptions(screen.getByLabelText('scribe-provider'), 'anthropic')
    await userEvent.selectOptions(screen.getByLabelText('scribe-model'), 'claude-opus-4-8')
    await userEvent.click(screen.getByRole('button', { name: 'Save workflow' }))
    await waitFor(() => expect(save).toHaveBeenCalled())
    const body = save.mock.calls[0]![0] as { agents: Array<{ role: string; model?: { providerId: string; modelId: string } }> }
    const scribe = body.agents.find(a => a.role === 'scribe')!
    expect(scribe.model).toEqual({ providerId: 'anthropic', modelId: 'claude-opus-4-8' })
  })
})
