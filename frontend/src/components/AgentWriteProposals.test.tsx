import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { AgentWriteProposals, classifyGithubAction, classifyGithubRisk } from './AgentWriteProposals.js'
import { I18nProvider } from '../i18n/I18nContext.js'
import type { ApiClient, ExternalWriteSummary } from '../api/client.js'

/** A proposed GitHub write fixture — the digest is the value the server bound (confirm posts it verbatim). */
function proposal(over: Partial<ExternalWriteSummary> & Pick<ExternalWriteSummary, 'action' | 'target' | 'payload'>): ExternalWriteSummary {
  return {
    id: 'w1', provider: 'github', summary: 'an agent proposal', digest: 'd'.repeat(64),
    status: 'proposed', proposedAt: '2026-06-08T00:00:00Z',
    ...over,
  }
}

function makeApi(writes: ExternalWriteSummary[], over: Partial<Record<keyof ApiClient, unknown>> = {}): ApiClient {
  return {
    listExternalWrites: vi.fn(() => Promise.resolve({ writes })),
    confirmExternalWrite: vi.fn(() => Promise.resolve({ ok: true, status: 'executed', result: 'PR merged' })),
    ...over,
  } as unknown as ApiClient
}

const ui = (api: ApiClient) => render(
  <I18nProvider>
    {/* tiny pollMs so the interval doesn't dangle, but the first paint comes from the initial load */}
    <AgentWriteProposals sessionId="s1" api={api} pollMs={100000} />
  </I18nProvider>,
)

describe('classifyGithubAction / classifyGithubRisk (pure)', () => {
  it('reads open vs close vs merge from the PAYLOAD, not just the action', () => {
    expect(classifyGithubAction('issue_write', { method: 'create' })).toBe('openIssue')
    expect(classifyGithubAction('issue_write', { method: 'update', state: 'closed' })).toBe('closeIssue')
    expect(classifyGithubAction('merge_pull_request', { merge_method: 'squash' })).toBe('mergePr')
    expect(classifyGithubAction('pull_request_review_write', { event: 'APPROVE' })).toBe('reviewApprove')
    expect(classifyGithubAction('update_pull_request', { state: 'closed' })).toBe('closePr')
  })
  it('classifies risk: merge=irreversible, close/APPROVE=destructive, else reversible', () => {
    expect(classifyGithubRisk('merge_pull_request', {})).toBe('irreversible')
    expect(classifyGithubRisk('issue_write', { state: 'closed' })).toBe('destructive')
    expect(classifyGithubRisk('pull_request_review_write', { event: 'APPROVE' })).toBe('destructive')
    expect(classifyGithubRisk('add_issue_comment', { body: 'hi' })).toBe('reversible')
  })
})

describe('AgentWriteProposals (confirm cards for agent-proposed GitHub writes)', () => {
  it('a plain comment proposal confirms DIRECTLY with the exact stored digest', async () => {
    const writes = [proposal({ id: 'c1', action: 'add_issue_comment', summary: 'Comment build result on #7', target: { owner: 'me', repo: 'app', issue_number: 7 }, payload: { body: 'AKIS finished: verified.' }, digest: 'c'.repeat(64) })]
    const api = makeApi(writes)
    ui(api)
    await waitFor(() => expect(screen.getByText(/Comment build result on #7/)).toBeInTheDocument())
    const confirm = screen.getByRole('button', { name: /Confirm \+ execute/ })
    expect(confirm).not.toBeDisabled() // no friction for a low-risk comment
    fireEvent.click(confirm)
    await waitFor(() => expect(api.confirmExternalWrite).toHaveBeenCalledWith('s1', 'c1', 'c'.repeat(64)))
  })

  it('a MERGE proposal renders the IRREVERSIBLE banner + disables Confirm until the PR number is typed, then posts the exact digest', async () => {
    const writes = [proposal({ id: 'm1', action: 'merge_pull_request', summary: 'Merge PR 18', target: { owner: 'me', repo: 'app', pullNumber: 18 }, payload: { merge_method: 'squash', base: 'main' }, digest: 'm'.repeat(64) })]
    const api = makeApi(writes)
    ui(api)
    await waitFor(() => expect(screen.getByText(/Merge PR 18/)).toBeInTheDocument())
    // IRREVERSIBLE banner names the PR + base.
    expect(screen.getByText(/IRREVERSIBLE/)).toBeInTheDocument()
    expect(screen.getByText(/MERGES PR #18 into main/)).toBeInTheDocument()
    // Confirm starts DISABLED.
    const confirm = screen.getByRole('button', { name: /Confirm \+ execute/ })
    expect(confirm).toBeDisabled()
    // A wrong number keeps it disabled.
    fireEvent.change(screen.getByPlaceholderText(/PR number/), { target: { value: '19' } })
    expect(confirm).toBeDisabled()
    // The exact PR number enables it.
    fireEvent.change(screen.getByPlaceholderText(/PR number/), { target: { value: '18' } })
    expect(confirm).not.toBeDisabled()
    fireEvent.click(confirm)
    await waitFor(() => expect(api.confirmExternalWrite).toHaveBeenCalledWith('s1', 'm1', 'm'.repeat(64)))
  })

  it('a CLOSE-issue proposal shows the destructive banner (no typed confirm)', async () => {
    const writes = [proposal({ id: 'cl1', action: 'issue_write', summary: 'Close #42', target: { owner: 'me', repo: 'app', issue_number: 42 }, payload: { method: 'update', state: 'closed', state_reason: 'completed' } })]
    const api = makeApi(writes)
    ui(api)
    await waitFor(() => expect(screen.getByText(/will CLOSE issue #42/)).toBeInTheDocument())
    // Destructive ≠ irreversible: Confirm is enabled (banner only, no typed-confirm gate).
    expect(screen.getByRole('button', { name: /Confirm \+ execute/ })).not.toBeDisabled()
    expect(screen.queryByPlaceholderText(/PR number/)).not.toBeInTheDocument()
  })

  it('renders ONLY the structured fields actually bound in target/payload (no unbound field shown)', async () => {
    const writes = [proposal({ id: 'r1', action: 'pull_request_review_write', summary: 'Trace verdict', target: { owner: 'me', repo: 'app', pullNumber: 9 }, payload: { method: 'create', event: 'APPROVE', body: '9 real tests passed.' } })]
    const api = makeApi(writes)
    ui(api)
    await waitFor(() => expect(screen.getByText(/Trace verdict/)).toBeInTheDocument())
    // Bound fields render…
    expect(screen.getByText('#9')).toBeInTheDocument()
    expect(screen.getByText('9 real tests passed.')).toBeInTheDocument()
    expect(screen.getByText('me/app')).toBeInTheDocument()
    expect(screen.getAllByText('APPROVE').length).toBeGreaterThan(0) // the colored review pill + field
    // …a field that is NOT in the payload (merge_method) must NOT appear.
    expect(screen.queryByText(/Merge method/)).not.toBeInTheDocument()
    // …and the APPROVE proposal carries the destructive 'can unblock merge' banner.
    expect(screen.getByText(/unblock a merge|UNBLOCK a merge/i)).toBeInTheDocument()
  })

  it('exact-bytes drawer shows the {target,payload} the digest binds + the digest prefix', async () => {
    const writes = [proposal({ id: 'b1', action: 'add_issue_comment', target: { owner: 'me', repo: 'app', issue_number: 1 }, payload: { body: 'hello' }, digest: 'abcdef0123456789'.repeat(4) })]
    const api = makeApi(writes)
    ui(api)
    await waitFor(() => screen.getByRole('button', { name: /Show exact bytes/ }))
    fireEvent.click(screen.getByRole('button', { name: /Show exact bytes/ }))
    expect(screen.getByText(/"issue_number": 1/)).toBeInTheDocument()
    expect(screen.getByText(/abcdef0123456789…/)).toBeInTheDocument()
  })

  it('a MERGE proposal shows commit_title + commit_message in the STRUCTURED view (not only the exact-bytes drawer)', async () => {
    // BUG-5: digest-bound merge-commit text must be visible in the structured "what executes" view without
    // expanding the default-collapsed exact-bytes drawer (the structuredFields catch-all renders it).
    const writes = [proposal({ id: 'mc1', action: 'merge_pull_request', summary: 'Merge PR 5', target: { owner: 'me', repo: 'app', pullNumber: 5 }, payload: { merge_method: 'squash', commit_title: 'Release v2', commit_message: 'Ship the verifiability layer' } })]
    const api = makeApi(writes)
    ui(api)
    await waitFor(() => expect(screen.getByText(/Merge PR 5/)).toBeInTheDocument())
    // The exact-bytes drawer is collapsed (Show, not Hide) — so these MUST be in the structured grid.
    expect(screen.getByRole('button', { name: /Show exact bytes/ })).toBeInTheDocument()
    expect(screen.getByText('Commit title')).toBeInTheDocument()
    expect(screen.getByText('Release v2')).toBeInTheDocument()
    expect(screen.getByText('Commit message')).toBeInTheDocument()
    expect(screen.getByText('Ship the verifiability layer')).toBeInTheDocument()
  })

  it('an UNKNOWN digest-bound payload key still renders in the structured view (generic catch-all)', async () => {
    // BUG-5: a key with no per-action row + no specific label falls back to "Other ({k})" with its value,
    // so nothing the digest binds is hidden. Objects/arrays stringify instead of "[object Object]".
    const writes = [proposal({ id: 'u1', action: 'create_pull_request', summary: 'Open a draft PR for review', target: { owner: 'me', repo: 'app' }, payload: { title: 'New PR', draft: true, some_future_key: { nested: 1 } } })]
    const api = makeApi(writes)
    ui(api)
    await waitFor(() => expect(screen.getByText(/Open a draft PR for review/)).toBeInTheDocument())
    // The known specific label for `draft`.
    expect(screen.getByText('Draft')).toBeInTheDocument()
    // The generic catch-all carries the raw key name + a JSON-stringified value.
    expect(screen.getByText(/Other \(some_future_key\)/)).toBeInTheDocument()
    expect(screen.getByText(/"nested":1/)).toBeInTheDocument()
  })

  it('ignores non-proposed and non-github records (only proposed github writes get a confirm card)', async () => {
    const writes = [
      proposal({ id: 'x1', action: 'add_issue_comment', target: {}, payload: {}, status: 'executed', summary: 'already done' }),
      proposal({ id: 'x2', provider: 'atlassian', action: 'createPage', target: {}, payload: {}, summary: 'jira proposal' }),
    ]
    const api = makeApi(writes)
    const { container } = ui(api)
    // Give the load a tick; nothing renders (no proposed github write).
    await waitFor(() => expect(api.listExternalWrites).toHaveBeenCalled())
    expect(screen.queryByText(/already done/)).not.toBeInTheDocument()
    expect(screen.queryByText(/jira proposal/)).not.toBeInTheDocument()
    expect(container.querySelector('section, [role="status"]')).toBeNull()
  })

  it('Dismiss hides a card without confirming (FE-only)', async () => {
    const writes = [proposal({ id: 'd1', action: 'add_issue_comment', summary: 'a comment', target: {}, payload: { body: 'x' } })]
    const api = makeApi(writes)
    ui(api)
    await waitFor(() => screen.getByText(/a comment/))
    fireEvent.click(screen.getByRole('button', { name: /Dismiss/ }))
    await waitFor(() => expect(screen.queryByText(/a comment/)).not.toBeInTheDocument())
    expect(api.confirmExternalWrite).not.toHaveBeenCalled()
  })
})

describe('AgentWriteProposals polling', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('re-polls the list so a proposal that arrives later surfaces live', async () => {
    let calls = 0
    const later = [proposal({ id: 'p1', action: 'add_issue_comment', summary: 'late proposal', target: {}, payload: { body: 'x' } })]
    const api = makeApi([], { listExternalWrites: vi.fn(() => { calls++; return Promise.resolve({ writes: calls >= 2 ? later : [] }) }) })
    render(<I18nProvider><AgentWriteProposals sessionId="s1" api={api} pollMs={1000} /></I18nProvider>)
    // initial load → empty
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.queryByText(/late proposal/)).not.toBeInTheDocument()
    // after one poll interval → the proposal appears
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(screen.getByText(/late proposal/)).toBeInTheDocument()
  })

  it('keeps the successful-confirm outcome panel visible across the poll tick that flips the record off proposed (BUG-6)', async () => {
    // After confirm, the server flips this record proposed → executed; the poll would drop it from the
    // 'proposed' filter and unmount the "Done: …" panel before the user reads it. It must stay pinned.
    const id = 'g1'
    const base = proposal({ id, action: 'merge_pull_request', summary: 'Merge PR 3', target: { owner: 'me', repo: 'app', pullNumber: 3 }, payload: { merge_method: 'squash' }, digest: 'g'.repeat(64) })
    let confirmed = false
    const api = makeApi([], {
      // Pre-confirm: returns the proposed record. Post-confirm: returns it as executed (no longer proposed).
      listExternalWrites: vi.fn(() => Promise.resolve({ writes: [confirmed ? { ...base, status: 'executed', result: 'PR merged' } : base] })),
      confirmExternalWrite: vi.fn(() => { confirmed = true; return Promise.resolve({ ok: true, status: 'executed', result: 'PR merged' }) }),
    })
    render(<I18nProvider><AgentWriteProposals sessionId="s1" api={api} pollMs={1000} /></I18nProvider>)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    // Type the PR number to clear the merge friction, then confirm.
    fireEvent.change(screen.getByPlaceholderText(/PR number/), { target: { value: '3' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Confirm \+ execute/ })); await Promise.resolve() })
    expect(screen.getByText(/Done: PR merged/)).toBeInTheDocument()
    // A poll tick now returns it as 'executed' (off 'proposed') — the outcome panel MUST still be visible.
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(screen.getByText(/Done: PR merged/)).toBeInTheDocument()
    // …and after the grace period it finally clears.
    await act(async () => { await vi.advanceTimersByTimeAsync(8000) })
    expect(screen.queryByText(/Done: PR merged/)).not.toBeInTheDocument()
  })
})
