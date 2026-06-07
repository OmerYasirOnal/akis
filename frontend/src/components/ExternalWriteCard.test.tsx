import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ExternalWriteCard } from './ExternalWriteCard.js'
import { I18nProvider } from '../i18n/I18nContext.js'
import { RouterProvider } from '../router/router.js'
import type { ApiClient, ExternalWriteSummary } from '../api/client.js'

function makeApi(over: Partial<Record<keyof ApiClient, unknown>> = {}): ApiClient {
  return {
    mcpStatus: vi.fn(() => Promise.resolve({ connected: true })),
    listExternalWrites: vi.fn(() => Promise.resolve({ writes: [] as ExternalWriteSummary[] })),
    proposeExternalWrite: vi.fn(() => Promise.resolve({ id: 'w1', digest: 'a'.repeat(64), summary: 'Create Confluence page “App” in ENG' })),
    confirmExternalWrite: vi.fn(() => Promise.resolve({ ok: true, status: 'executed', result: 'https://org/wiki/PAGE-1' })),
    ...over,
  } as unknown as ApiClient
}

const ui = (api: ApiClient) => render(
  <RouterProvider>
    <I18nProvider>
      <ExternalWriteCard sessionId="s1" idea="App" files={[{ filePath: 'README.md', content: '# App' }]} api={api} />
    </I18nProvider>
  </RouterProvider>,
)

describe('ExternalWriteCard (connection-aware publish to Jira/Confluence)', () => {
  it('NOT connected → guides to Settings, hides the publish buttons (no confirm-time 409 surprise)', async () => {
    const api = makeApi({ mcpStatus: vi.fn(() => Promise.resolve({ connected: false })) })
    ui(api)
    await waitFor(() => expect(screen.getByText(/Connect Jira\/Confluence in Settings/)).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /Publish to Confluence/ })).not.toBeInTheDocument()
  })

  it('connected → propose → review (digest) → confirm publishes via the user connection', async () => {
    const api = makeApi()
    ui(api)
    await waitFor(() => screen.getByRole('button', { name: /Publish to Confluence/ }))
    fireEvent.click(screen.getByRole('button', { name: /Publish to Confluence/ }))
    fireEvent.change(screen.getByPlaceholderText(/Confluence space key/), { target: { value: 'ENG' } })
    fireEvent.click(screen.getByRole('button', { name: /Review/ }))
    await waitFor(() => expect(screen.getByText(/Content digest/)).toBeInTheDocument())
    expect(api.proposeExternalWrite).toHaveBeenCalledWith('s1', expect.objectContaining({ action: 'createPage', target: { spaceKey: 'ENG' } }))
    // #22: the human sees the EXACT target + payload bytes before confirming (not just a summary).
    expect(screen.getByText(/Exactly what will be written/)).toBeInTheDocument()
    expect(screen.getByText(/"spaceKey": "ENG"/)).toBeInTheDocument()
    expect(screen.getByText(/"title": "App"/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Confirm \+ publish/ }))
    await waitFor(() => expect(api.confirmExternalWrite).toHaveBeenCalledWith('s1', 'w1', 'a'.repeat(64)))
    await waitFor(() => expect(screen.getByText(/PAGE-1/)).toBeInTheDocument())
  })

  it('renders the proposal history with status badges', async () => {
    const writes: ExternalWriteSummary[] = [
      { id: 'h1', provider: 'atlassian', summary: 'Create Jira issue “App”', action: 'createJiraIssue', status: 'executed', result: 'ISSUE-9', proposedAt: '2026-06-07T00:00:00Z' },
    ]
    const api = makeApi({ listExternalWrites: vi.fn(() => Promise.resolve({ writes })) })
    ui(api)
    await waitFor(() => expect(screen.getByText(/Publish history/)).toBeInTheDocument())
    expect(screen.getByText(/ISSUE-9/)).toBeInTheDocument()
  })
})
