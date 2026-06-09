import { describe, it, expect, vi } from 'vitest'
import { render, screen, act, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { ProviderKeys } from './ProviderKeys.js'
import { I18nProvider } from '../i18n/I18nContext.js'
import type { ApiClient, ProviderInfo } from '../api/client.js'

const renderI18n = (ui: ReactElement) => render(<I18nProvider>{ui}</I18nProvider>)

/** Minimal fake: only the provider-key surface that ProviderKeys touches. */
function fakeApi(over: Partial<ApiClient> = {}): ApiClient {
  return {
    listProviders: async () => [] as ProviderInfo[],
    setProviderKey: async () => undefined,
    removeProviderKey: async () => undefined,
    ...over,
  } as unknown as ApiClient
}

describe('ProviderKeys', () => {
  it('shows the loading row while listProviders is in flight, then the provider rows', async () => {
    // A deferred promise so we can assert the loading state before it resolves.
    let resolveProviders!: (list: ProviderInfo[]) => void
    const pending = new Promise<ProviderInfo[]>(r => { resolveProviders = r })

    renderI18n(<ProviderKeys api={fakeApi({ listProviders: () => pending })} />)

    // (a) Loading row must be visible while fetch is in flight.
    expect(await screen.findByText('Loading…')).toBeInTheDocument()

    // (b) Resolve with a real provider list → loading row gone, provider rows appear.
    const providers: ProviderInfo[] = [
      { id: 'openai', label: 'OpenAI', available: false, defaultModel: 'gpt-4o', models: [] },
      { id: 'anthropic', label: 'Anthropic', available: true, last4: 'abcd', defaultModel: 'claude-3-5-sonnet-20241022', models: [] },
    ]
    await act(async () => { resolveProviders(providers); await pending })

    // Provider labels are rendered.
    expect(await screen.findByText('OpenAI')).toBeInTheDocument()
    expect(screen.getByText('Anthropic')).toBeInTheDocument()

    // Anthropic is connected with last4 visible.
    expect(screen.getByText(/••••abcd/)).toBeInTheDocument()

    // Loading row is gone.
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument()
  })

  it('clears the loading row on a fetch failure (catch resolves to [])', async () => {
    // If listProviders rejects, the catch branch sets providers=[] and the empty grid renders
    // instead of being stuck on the loading row forever.
    renderI18n(<ProviderKeys api={fakeApi({ listProviders: async () => { throw new Error('503') } })} />)

    // Loading row appears first.
    expect(await screen.findByText('Loading…')).toBeInTheDocument()

    // The catch branch sets providers=[] — the spinner must disappear (no infinite loading row).
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument())
  })
})
