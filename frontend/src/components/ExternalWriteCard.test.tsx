import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { ExternalWriteCard } from './ExternalWriteCard.js'
import { I18nProvider } from '../i18n/I18nContext.js'
import { RouterProvider } from '../router/router.js'
import { ApiError } from '../api/client.js'
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
      { id: 'h1', provider: 'atlassian', summary: 'Create Jira issue “App”', action: 'createJiraIssue', target: {}, payload: {}, digest: 'abc', status: 'executed', result: 'ISSUE-9', proposedAt: '2026-06-07T00:00:00Z' },
    ]
    const api = makeApi({ listExternalWrites: vi.fn(() => Promise.resolve({ writes })) })
    ui(api)
    await waitFor(() => expect(screen.getByText(/Publish history/)).toBeInTheDocument())
    expect(screen.getByText(/ISSUE-9/)).toBeInTheDocument()
  })

  it('a github PROPOSED write does NOT appear in history — AgentWriteProposals owns it (BUG-8, no double-render)', async () => {
    const writes: ExternalWriteSummary[] = [
      // Owned by AgentWriteProposals (the confirm surface) — must be dropped from this read-only history.
      { id: 'gp1', provider: 'github', summary: 'AKIS proposes: merge PR #4', action: 'merge_pull_request', target: { pullNumber: 4 }, payload: { merge_method: 'squash' }, digest: 'gh', status: 'proposed', proposedAt: '2026-06-08T00:00:00Z' },
      // An EXECUTED github write still belongs in history (it has no confirm card anywhere).
      { id: 'ge1', provider: 'github', summary: 'merged PR #2', action: 'merge_pull_request', target: { pullNumber: 2 }, payload: {}, digest: 'gh2', status: 'executed', result: 'PR #2 merged', proposedAt: '2026-06-08T00:00:00Z' },
    ]
    const api = makeApi({ listExternalWrites: vi.fn(() => Promise.resolve({ writes })) })
    ui(api)
    await waitFor(() => expect(screen.getByText(/Publish history/)).toBeInTheDocument())
    // The proposed github write is filtered out…
    expect(screen.queryByText(/AKIS proposes: merge PR #4/)).not.toBeInTheDocument()
    // …but the executed one remains.
    expect(screen.getByText(/merged PR #2/)).toBeInTheDocument()
  })
})

/* ───────────────────────── REGRESSION GUARDS (verified-but-unguarded) ───────────────────────── */

/** Drive a connected card through propose → review so a confirm error is observable. The propose mock
 *  returns a digest; the supplied confirm mock decides the failure mode. */
async function reachReviewThenConfirm(api: ApiClient): Promise<void> {
  ui(api)
  await waitFor(() => screen.getByRole('button', { name: /Publish to Confluence/ }))
  fireEvent.click(screen.getByRole('button', { name: /Publish to Confluence/ }))
  fireEvent.change(screen.getByPlaceholderText(/Confluence space key/), { target: { value: 'ENG' } })
  fireEvent.click(screen.getByRole('button', { name: /Review/ }))
  await waitFor(() => expect(screen.getByText(/Content digest/)).toBeInTheDocument())
  // propose-success triggers a second loadHistory() — let it settle before confirming so the only
  // pending state update during the error assertion is the one under test (no stray act() warning).
  await waitFor(() => expect((api.listExternalWrites as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2))
  // confirm() is fire-and-forget (void confirm()); flush its async catch/finally inside act so the
  // setErr + setBusy(false) updates are captured (no "not wrapped in act" warning).
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Confirm \+ publish/ })); await Promise.resolve(); await Promise.resolve() })
}

describe('ExternalWriteCard — confirm error mapping (atlassian FR-23)', () => {
  it('confirm rejects with ApiError(409) → shows the friendly mcpwrite.notConnected guidance (NOT the raw provider message)', async () => {
    const api = makeApi({
      // A 409 at confirm-time = the connection dropped / MCP unavailable. The card maps it to the
      // localized "Connect … in Settings first." guidance instead of leaking the raw 409 string.
      confirmExternalWrite: vi.fn(() => Promise.reject(new ApiError(409, 'McpUnavailable: token expired', 'McpUnavailable'))),
    })
    await reachReviewThenConfirm(api)
    // The ErrorNote surfaces the friendly guidance — and the raw provider detail is NOT shown.
    await waitFor(() => expect(screen.getByText(/Connect Jira\/Confluence in Settings first\./)).toBeInTheDocument())
    // Wait for `busy` to settle back to false (Confirm usable again) so the trailing state update is captured.
    await waitFor(() => expect(screen.getByRole('button', { name: /Confirm \+ publish/ })).not.toBeDisabled())
    expect(screen.queryByText(/token expired/)).not.toBeInTheDocument()
    // The card did NOT advance to a "done" panel on this failure.
    expect(screen.queryByText(/PAGE-1/)).not.toBeInTheDocument()
  })

  it('confirm rejects with a NON-409 ApiError → shows that error\'s OWN message (not the 409 guidance)', async () => {
    const api = makeApi({
      confirmExternalWrite: vi.fn(() => Promise.reject(new ApiError(500, 'Confluence rejected the page body', 'WriteFailed'))),
    })
    await reachReviewThenConfirm(api)
    // A non-409 surfaces e.message verbatim — the 409-only guidance must NOT be substituted.
    await waitFor(() => expect(screen.getByText(/Confluence rejected the page body/)).toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole('button', { name: /Confirm \+ publish/ })).not.toBeDisabled())
    expect(screen.queryByText(/Connect Jira\/Confluence in Settings first\./)).not.toBeInTheDocument()
  })
})
