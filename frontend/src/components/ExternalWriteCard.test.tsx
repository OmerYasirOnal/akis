import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ExternalWriteCard } from './ExternalWriteCard.js'
import { I18nProvider } from '../i18n/I18nContext.js'
import { RouterProvider } from '../router/router.js'
import type { ApiClient, ExternalWriteSummary } from '../api/client.js'

// Default connected status grants Confluence write so the legacy publish-to-Confluence flow still
// renders. The scope string mirrors the backend grant (write:confluence-content = createPage capability).
const SCOPES_WITH_CONFLUENCE = 'offline_access read:me read:jira-work write:jira-work read:confluence-content.all write:confluence-content'
// JIRA-ONLY grant (owner decision 2026-06-08) — no Confluence write, so createPage must NOT be offered.
const SCOPES_JIRA_ONLY = 'offline_access read:me read:jira-work write:jira-work'

function makeApi(over: Partial<Record<keyof ApiClient, unknown>> = {}): ApiClient {
  return {
    mcpStatus: vi.fn(() => Promise.resolve({ connected: true, scopes: SCOPES_WITH_CONFLUENCE })),
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

  it('JIRA-ONLY grant → Confluence publish HIDDEN (no createPage that would fail at execution); Jira unaffected', async () => {
    const api = makeApi({ mcpStatus: vi.fn(() => Promise.resolve({ connected: true, scopes: SCOPES_JIRA_ONLY })) })
    ui(api)
    // Jira stays available...
    await waitFor(() => expect(screen.getByRole('button', { name: /Create Jira issue/ })).toBeInTheDocument())
    // ...but Confluence is gone, with an explanatory note (data-driven on the granted scope).
    expect(screen.queryByRole('button', { name: /Publish to Confluence/ })).not.toBeInTheDocument()
    expect(screen.getByText(/Confluence publishing isn’t available/)).toBeInTheDocument()
  })

  it('scopes unknown (connected but no scopes field) → FAIL SAFE, Confluence not offered', async () => {
    const api = makeApi({ mcpStatus: vi.fn(() => Promise.resolve({ connected: true })) })
    ui(api)
    await waitFor(() => expect(screen.getByRole('button', { name: /Create Jira issue/ })).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /Publish to Confluence/ })).not.toBeInTheDocument()
  })

  it('grant INCLUDES write:confluence-content → Confluence publish is offered again (auto-restore)', async () => {
    const api = makeApi() // default scopes include write:confluence-content
    ui(api)
    await waitFor(() => expect(screen.getByRole('button', { name: /Publish to Confluence/ })).toBeInTheDocument())
    expect(screen.queryByText(/Confluence publishing isn’t available/)).not.toBeInTheDocument()
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
