import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { AgentWriteProposals, classifyGithubAction, classifyGithubRisk } from './AgentWriteProposals.js'
import { I18nProvider } from '../i18n/I18nContext.js'
import { ApiError } from '../api/client.js'
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

/* ───────────────────────── REGRESSION GUARDS (verified-but-unguarded) ───────────────────────── */

describe('AgentWriteProposals — resilient load (FR-confirm-cards-1 / NFR-4 / UC-6)', () => {
  it('a listExternalWrites that REJECTS surfaces nothing (null) and never throws out of the component', async () => {
    // The load wraps the call in Promise.resolve().then so a rejection is .catch-swallowed → empty surface.
    const api = makeApi([], { listExternalWrites: vi.fn(() => Promise.reject(new Error('network down'))) })
    const { container } = ui(api)
    await waitFor(() => expect(api.listExternalWrites).toHaveBeenCalled())
    // No section, no status node — the component degraded to render-nothing instead of crashing the build view.
    expect(container.firstChild).toBeNull()
    expect(container.querySelector('section, [role="status"], [role="alert"]')).toBeNull()
  })

  it('a listExternalWrites that THROWS SYNCHRONOUSLY (partial/older mock) is caught — renders nothing, does NOT throw', async () => {
    // The Promise.resolve().then wrapper turns a synchronous throw into a handled rejection.
    const api = makeApi([], { listExternalWrites: vi.fn(() => { throw new Error('sync boom') }) })
    // render must NOT throw — if the wrapper regressed (direct call), this line would blow up the test.
    const { container } = ui(api)
    await waitFor(() => expect(api.listExternalWrites).toHaveBeenCalled())
    expect(container.firstChild).toBeNull()
  })

  it('recovers: after an initial failure, a later successful poll surfaces the proposal', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const later = [proposal({ id: 'rec1', action: 'add_issue_comment', summary: 'recovered proposal', target: {}, payload: { body: 'x' } })]
      const api = makeApi([], {
        listExternalWrites: vi.fn(() => { calls++; return calls === 1 ? Promise.reject(new Error('first call fails')) : Promise.resolve({ writes: later }) }),
      })
      render(<I18nProvider><AgentWriteProposals sessionId="s1" api={api} pollMs={1000} /></I18nProvider>)
      // initial load rejects → nothing shown
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(screen.queryByText(/recovered proposal/)).not.toBeInTheDocument()
      // next poll tick succeeds → the proposal appears (recovery, not a permanent dead surface)
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      expect(screen.getByText(/recovered proposal/)).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('AgentWriteProposals — review-event pill color (FR-confirm-cards-5)', () => {
  it('REQUEST_CHANGES renders a ROSE pill; COMMENT renders a slate pill (NOT rose/emerald)', async () => {
    const rc = [proposal({ id: 'rc1', action: 'pull_request_review_write', summary: 'Request changes', target: { owner: 'me', repo: 'app', pullNumber: 3 }, payload: { method: 'create', event: 'REQUEST_CHANGES', body: 'fix this' } })]
    const { unmount } = render(<I18nProvider><AgentWriteProposals sessionId="s1" api={makeApi(rc)} pollMs={100000} /></I18nProvider>)
    // The review pill is the colored chip in the header. Find the one carrying the event-specific class.
    await waitFor(() => expect(screen.getAllByText('REQUEST_CHANGES').length).toBeGreaterThan(0))
    const rosePill = screen.getAllByText('REQUEST_CHANGES').find(el => el.className.includes('rounded') && el.className.includes('border'))
    expect(rosePill).toBeDefined()
    expect(rosePill!.className).toMatch(/rose/)
    expect(rosePill!.className).not.toMatch(/emerald/)
    unmount()

    const cm = [proposal({ id: 'cm1', action: 'pull_request_review_write', summary: 'Just a comment', target: { owner: 'me', repo: 'app', pullNumber: 4 }, payload: { method: 'create', event: 'COMMENT', body: 'note' } })]
    render(<I18nProvider><AgentWriteProposals sessionId="s1" api={makeApi(cm)} pollMs={100000} /></I18nProvider>)
    await waitFor(() => expect(screen.getAllByText('COMMENT').length).toBeGreaterThan(0))
    const slatePill = screen.getAllByText('COMMENT').find(el => el.className.includes('rounded') && el.className.includes('border'))
    expect(slatePill).toBeDefined()
    // slate/neutral pill — explicitly NOT the rose (REQUEST_CHANGES) or emerald (APPROVE) color.
    expect(slatePill!.className).toMatch(/slate/)
    expect(slatePill!.className).not.toMatch(/rose/)
    expect(slatePill!.className).not.toMatch(/emerald/)
  })

  it('APPROVE renders an EMERALD pill (the third, distinct color)', async () => {
    const ap = [proposal({ id: 'ap1', action: 'pull_request_review_write', summary: 'Approve it', target: { owner: 'me', repo: 'app', pullNumber: 5 }, payload: { method: 'create', event: 'APPROVE', body: 'lgtm' } })]
    render(<I18nProvider><AgentWriteProposals sessionId="s1" api={makeApi(ap)} pollMs={100000} /></I18nProvider>)
    await waitFor(() => expect(screen.getAllByText('APPROVE').length).toBeGreaterThan(0))
    const emeraldPill = screen.getAllByText('APPROVE').find(el => el.className.includes('rounded') && el.className.includes('border'))
    expect(emeraldPill).toBeDefined()
    expect(emeraldPill!.className).toMatch(/emerald/)
    expect(emeraldPill!.className).not.toMatch(/rose/)
  })
})

describe('AgentWriteProposals — string-typed numbers (FR-confirm-cards-9)', () => {
  it('pullNumber "18" as a STRING → banner names PR #18 and typed-confirm enables on typing "18"', async () => {
    const writes = [proposal({ id: 's18', action: 'merge_pull_request', summary: 'Merge PR (string)', target: { owner: 'me', repo: 'app', pullNumber: '18' as unknown as number }, payload: { merge_method: 'squash', base: 'main' }, digest: 's'.repeat(64) })]
    const api = makeApi(writes)
    ui(api)
    await waitFor(() => expect(screen.getByText(/Merge PR \(string\)/)).toBeInTheDocument())
    // The numeric STRING is coerced (numLike) so the banner names the real PR.
    expect(screen.getByText(/MERGES PR #18 into main/)).toBeInTheDocument()
    const confirm = screen.getByRole('button', { name: /Confirm \+ execute/ })
    expect(confirm).toBeDisabled()
    // Typing the same digits enables Confirm (typedOk compares against String(18)).
    fireEvent.change(screen.getByPlaceholderText(/PR number/), { target: { value: '18' } })
    expect(confirm).not.toBeDisabled()
    fireEvent.click(confirm)
    await waitFor(() => expect(api.confirmExternalWrite).toHaveBeenCalledWith('s1', 's18', 's'.repeat(64)))
  })

  it('issue_number "7" as a STRING → the structured "#7" row renders (numeric-string coercion)', async () => {
    const writes = [proposal({ id: 's7', action: 'add_issue_comment', summary: 'Comment on the issue', target: { owner: 'me', repo: 'app', issue_number: '7' as unknown as number }, payload: { body: 'hi' } })]
    const api = makeApi(writes)
    ui(api)
    await waitFor(() => expect(screen.getByText(/Comment on the issue/)).toBeInTheDocument())
    expect(screen.getByText('#7')).toBeInTheDocument()
  })
})

describe('AgentWriteProposals — confirm lifecycle (FR-confirm-cards-16)', () => {
  it('a deferred confirm disables BOTH buttons + shows "Confirming…"; a {ok:false} return shows the "Failed:" panel', async () => {
    // A promise we resolve by hand so we can observe the in-flight (busy) state deterministically.
    let resolveConfirm!: (v: { ok: boolean; status: string; result: string }) => void
    const confirmExternalWrite = vi.fn(() => new Promise<{ ok: boolean; status: string; result: string }>(res => { resolveConfirm = res }))
    const writes = [proposal({ id: 'lc1', action: 'add_issue_comment', summary: 'a deferred comment', target: { owner: 'me', repo: 'app', issue_number: 1 }, payload: { body: 'x' }, digest: 'd'.repeat(64) })]
    const api = makeApi(writes, { confirmExternalWrite })
    ui(api)
    await waitFor(() => screen.getByText(/a deferred comment/))
    const confirm = screen.getByRole('button', { name: /Confirm \+ execute/ })
    const dismiss = screen.getByRole('button', { name: /Dismiss/ })
    fireEvent.click(confirm)
    // In-flight: label flips to "Confirming…" and BOTH actions are disabled (no double-fire / no dismiss-mid-flight).
    await waitFor(() => expect(screen.getByRole('button', { name: /Confirming…/ })).toBeDisabled())
    expect(dismiss).toBeDisabled()
    // Resolve with a server failure → the Failed panel surfaces the result text.
    await act(async () => { resolveConfirm({ ok: false, status: 'failed', result: 'merge conflict' }); await Promise.resolve() })
    await waitFor(() => expect(screen.getByText(/Failed: merge conflict/)).toBeInTheDocument())
  })
})

describe('AgentWriteProposals — confirm error recovery & retry (FR-confirm-cards-17 / NFR-10)', () => {
  it('a rejected confirm (ApiError 409 McpUnavailable) shows the message, RE-ENABLES Confirm, and a 2nd click re-calls confirm', async () => {
    const confirmExternalWrite = vi.fn()
      .mockRejectedValueOnce(new ApiError(409, 'McpUnavailable', 'McpUnavailable'))
      .mockResolvedValueOnce({ ok: true, status: 'executed', result: 'commented' })
    const writes = [proposal({ id: 'retry1', action: 'add_issue_comment', summary: 'retryable comment', target: { owner: 'me', repo: 'app', issue_number: 2 }, payload: { body: 'x' }, digest: 'r'.repeat(64) })]
    const api = makeApi(writes, { confirmExternalWrite })
    ui(api)
    await waitFor(() => screen.getByText(/retryable comment/))
    const confirm = screen.getByRole('button', { name: /Confirm \+ execute/ })
    fireEvent.click(confirm)
    // The ErrorNote shows the ApiError message…
    await waitFor(() => expect(screen.getByText(/McpUnavailable/)).toBeInTheDocument())
    // …busy is cleared so Confirm is usable again (a transient MCP outage isn't a dead end).
    await waitFor(() => expect(screen.getByRole('button', { name: /Confirm \+ execute/ })).not.toBeDisabled())
    expect(confirmExternalWrite).toHaveBeenCalledTimes(1)
    // A second click RETRIES — same args (the record's own digest) — and this time succeeds.
    fireEvent.click(screen.getByRole('button', { name: /Confirm \+ execute/ }))
    await waitFor(() => expect(confirmExternalWrite).toHaveBeenCalledTimes(2))
    expect(confirmExternalWrite).toHaveBeenLastCalledWith('s1', 'retry1', 'r'.repeat(64))
    await waitFor(() => expect(screen.getByText(/Done: commented/)).toBeInTheDocument())
  })
})

describe('AgentWriteProposals — grace-timer cleanup on unmount (FR-confirm-cards-20 / reliability FR-23)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('confirm then UNMOUNT before the 8s grace expires → advancing fake timers past 8000ms triggers no setState-after-unmount / act warning', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const writes = [proposal({ id: 'gt1', action: 'add_issue_comment', summary: 'graced comment', target: { owner: 'me', repo: 'app', issue_number: 9 }, payload: { body: 'x' }, digest: 'g'.repeat(64) })]
      const api = makeApi(writes)
      const { unmount } = render(<I18nProvider><AgentWriteProposals sessionId="s1" api={api} pollMs={100000} /></I18nProvider>)
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      // Confirm starts the 8s grace timer (RESOLVED_GRACE_MS).
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Confirm \+ execute/ })); await Promise.resolve() })
      expect(screen.getByText(/Done: PR merged/)).toBeInTheDocument()
      // Unmount BEFORE the grace expires — the unmount effect must clear the pending timer.
      unmount()
      // Advance well past 8000ms — a leaked timer would fire drop()/setState on an unmounted tree.
      await act(async () => { await vi.advanceTimersByTimeAsync(20000) })
      // No React "setState on unmounted component" / act() warning was logged.
      const warnings = errSpy.mock.calls.map(c => String(c[0]))
      expect(warnings.some(w => /unmounted|not wrapped in act|setState/i.test(w))).toBe(false)
      expect(errSpy).not.toHaveBeenCalled()
    } finally {
      errSpy.mockRestore()
    }
  })
})

describe('AgentWriteProposals — long-text truncation (NFR-confirm-cards-5 / ext-write-gate NFR-5)', () => {
  it('a >500-char body is truncated (<=241 chars, ends with "…") in the structured view', async () => {
    const longBody = 'B'.repeat(600)
    const writes = [proposal({ id: 'lt1', action: 'add_issue_comment', summary: 'a long comment', target: { owner: 'me', repo: 'app', issue_number: 1 }, payload: { body: longBody } })]
    const api = makeApi(writes)
    ui(api)
    await waitFor(() => screen.getByText(/a long comment/))
    // The body row holds the truncated text: 240 chars + ellipsis = 241, never the full 600.
    const rendered = screen.getByText((_t, el) => el?.tagName === 'DD' && (el.textContent ?? '').startsWith('BBBB'))
    const text = rendered.textContent ?? ''
    expect(text.length).toBeLessThanOrEqual(241)
    expect(text.endsWith('…')).toBe(true)
    expect(text).not.toBe(longBody)
  })

  it('a confirm RESULT >200 chars is clipped to <=200 in the Done panel', async () => {
    const longResult = 'R'.repeat(500)
    const confirmExternalWrite = vi.fn(() => Promise.resolve({ ok: true, status: 'executed', result: longResult }))
    const writes = [proposal({ id: 'lr1', action: 'add_issue_comment', summary: 'will return long result', target: { owner: 'me', repo: 'app', issue_number: 1 }, payload: { body: 'x' }, digest: 'd'.repeat(64) })]
    const api = makeApi(writes, { confirmExternalWrite })
    ui(api)
    await waitFor(() => screen.getByText(/will return long result/))
    fireEvent.click(screen.getByRole('button', { name: /Confirm \+ execute/ }))
    const panel = await screen.findByRole('status')
    // "Done: " prefix + at most 200 chars of result. The raw 500-char result must never reach the DOM whole.
    const resultPortion = (panel.textContent ?? '').replace(/^Done:\s*/, '')
    expect(resultPortion.length).toBeLessThanOrEqual(200)
    expect(panel.textContent).not.toContain(longResult)
  })
})
