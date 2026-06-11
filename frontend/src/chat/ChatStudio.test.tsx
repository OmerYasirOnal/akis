import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { ChatStudio } from './ChatStudio.js'
import { RunPipeline } from './RunPipeline.js'
import { I18nProvider } from '../i18n/I18nContext.js'
import { RouterProvider } from '../router/router.js'
import { ApiClient } from '../api/client.js'
import { EventStreamClient } from '../live/EventStreamClient.js'
import { emptyView } from '../live/viewModel.js'
import type { SessionView } from '../live/types.js'
import type { AkisEvent } from '@akis/shared'

// ChatStudio renders ExternalWriteCard (which links to /settings via the SPA Link) on a done build,
// so the studio tree needs the router context the app always provides in production.
const wrap = (ui: ReactNode) => <RouterProvider><I18nProvider>{ui}</I18nProvider></RouterProvider>

/** A controllable fake stream client (EventStreamClient-shaped). The gone-card path is driven
 *  by getSession's 404, not by the SSE stream, so this stream stays inert in these tests. */
class FakeStream {
  connectedUrl?: string
  connect(url: string): void { this.connectedUrl = url }
  close(): void {}
}

/** Build a fetch mock for a deep-linked session whose getSession resolves to `getStatus`/`getBody`.
 *  `/sessions/mine` lists the deep-linked id so the deep-link resolves and sets sessionId; then the
 *  getSession effect runs and hits the status we want (404 = gone, 500 = transient, 200 = valid). */
function deepLinkFetch(id: string, getStatus: number, getBody: unknown = {}): (path: string) => Promise<Response> {
  return async (path: string) => {
    if (path.endsWith('/sessions/mine')) {
      return { ok: true, status: 200, json: async () => ([{ id, idea: 'an old build', status: 'done', verified: true }]), text: async () => '' } as unknown as Response
    }
    if (path.endsWith(`/sessions/${id}`)) {
      return { ok: getStatus >= 200 && getStatus < 300, status: getStatus, json: async () => getBody, text: async () => '' } as unknown as Response
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response
  }
}

describe('ChatStudio F5/deep-link rehydrate — the persisted conversation survives a refresh', () => {
  beforeEach(() => { localStorage.clear(); window.history.replaceState({}, '', '/?s=schat') })
  afterEach(() => { window.history.replaceState({}, '', '/') })

  it('restores session.chat turns into the thread (F5 used to clobber them via the seed)', async () => {
    const body = {
      id: 'schat', status: 'verify_failed', idea: 'todo app', version: 4,
      chat: [
        { role: 'user', content: 'Neden testler geçmiyor?', at: '2026-06-06T08:00:00.000Z' },
        { role: 'assistant', content: 'Doğrulama 0 test üretti — retry ile yeniden dene.', at: '2026-06-06T08:00:05.000Z' },
      ],
    }
    const api = new ApiClient('', vi.fn(deepLinkFetch('schat', 200, body)))
    const fake = new FakeStream()
    render(wrap(<ChatStudio api={api} makeClient={() => fake as unknown as EventStreamClient} />))
    // Both persisted turns are rehydrated into the visible thread — the F5 fix, end to end.
    await waitFor(() => expect(screen.getByText('Neden testler geçmiyor?')).toBeInTheDocument())
    expect(screen.getByText(/Doğrulama 0 test üretti/)).toBeInTheDocument()
  })

  // CONVERSATION-LOST FIX: a reopen MERGES (not overwrites) the local spine. The pre-build,
  // sessionId-less turns live ONLY in localStorage (the server can never hold them — they were
  // typed before the build existed). When the local spine already anchors this run, mergeSpine
  // KEEPS it (same-device local is authoritative), so a thinner server chat can't drop them.
  it('reopening a build via ?s= does NOT drop pre-build conversation (merge, not overwrite)', async () => {
    window.history.replaceState({}, '', '/?s=s1')
    // Local spine already has the run marker for s1 PLUS a pre-build user turn the server never saw.
    localStorage.setItem('akis_chat_thread', JSON.stringify([
      { role: 'assistant', content: 'GREETING' },
      { role: 'user', content: 'a note app please' },
      { role: 'run', sessionId: 's1', idea: 'note app' },
    ]))
    // The server's session.chat is THINNER (only the post-build turn) — it must NOT clobber the local.
    const api = new ApiClient('', vi.fn(deepLinkFetch('s1', 200, {
      id: 's1', idea: 'note app', status: 'done', version: 1,
      chat: [{ role: 'assistant', content: 'on it', at: '' }],
    })))
    // MASKING GUARD: the pre-build turn is already in localStorage, so AkisChat renders it on its
    // INITIAL mount — BEFORE the async deep-link chain (listMySessions → openWithChat → getSession →
    // seedRun) reseeds. A naive getByText therefore passes even against the OLD overwrite seed. Spy
    // on getSession and wait for the deep-link's call with 's1' so we observe AFTER the reseed has run.
    const getSessionSpy = vi.spyOn(api, 'getSession')
    const fake = new FakeStream()
    render(wrap(<ChatStudio api={api} makeClient={() => fake as unknown as EventStreamClient} />))
    await waitFor(() => expect(getSessionSpy).toHaveBeenCalledWith('s1'))
    // The pre-build turn survived the reseed — in BOTH the visible thread AND the persisted spine
    // (the old overwrite seed dropped it from both; the merge keeps it).
    await waitFor(() => expect(screen.getByText('a note app please')).toBeInTheDocument())
    expect(JSON.parse(localStorage.getItem('akis_chat_thread')!)).toEqual(
      expect.arrayContaining([expect.objectContaining({ content: 'a note app please' })]),
    )
  })
})

// HONESTY: a build that EDITS a prior app must disclose the merge-over-base where the user JUDGES
// the result — i.e. in the preview DRAWER too, not only above the chat. The badge reuses the same
// `pipeline.editsBase` copy; here we assert it travels into the drawer's cards region when base is set.
describe('ChatStudio — editsBase disclosure surfaces in the preview drawer', () => {
  beforeEach(() => { localStorage.clear(); window.history.replaceState({}, '', '/?s=smerge') })
  afterEach(() => { window.history.replaceState({}, '', '/') })

  it('renders the editsBase badge inside the drawer cards when the session merges over a base', async () => {
    // getSession returns a `base` → editsBase flips true. The deep-link sets activeSessionId, so the
    // drawer mounts; the badge appears both above the chat AND in the drawer's cards.
    const body = { id: 'smerge', status: 'done', version: 2, base: { files: [], fromSession: 'sPrev' } }
    const api = new ApiClient('', vi.fn(deepLinkFetch('smerge', 200, body)))
    const fake = new FakeStream()
    render(wrap(<ChatStudio api={api} makeClient={() => fake as unknown as EventStreamClient} />))
    const drawer = await screen.findByTestId('preview-drawer')
    await waitFor(() =>
      expect(within(drawer).getByText('Editing the previous app — changes merge over its files')).toBeInTheDocument(),
    )
  })

  it('does NOT render the editsBase badge in the drawer when the session has no base', async () => {
    const body = { id: 'smerge', status: 'done', version: 1 }
    const api = new ApiClient('', vi.fn(deepLinkFetch('smerge', 200, body)))
    const fake = new FakeStream()
    render(wrap(<ChatStudio api={api} makeClient={() => fake as unknown as EventStreamClient} />))
    const drawer = await screen.findByTestId('preview-drawer')
    // settle the getSession effect, then assert the disclosure never appeared anywhere
    await waitFor(() => expect(fake.connectedUrl).toBe('/sessions/smerge/events'))
    await Promise.resolve()
    expect(within(drawer).queryByText('Editing the previous app — changes merge over its files')).toBeNull()
    expect(screen.queryByText('Editing the previous app — changes merge over its files')).toBeNull()
  })
})

describe('ChatStudio stale deep-link recovery', () => {
  beforeEach(() => { localStorage.clear(); window.history.replaceState({}, '', '/?s=sgone') })
  afterEach(() => { window.history.replaceState({}, '', '/') })

  it('shows the stale-session card when getSession returns 404', async () => {
    const api = new ApiClient('', vi.fn(deepLinkFetch('sgone', 404, { error: 'not found' })))
    const fake = new FakeStream()
    render(wrap(<ChatStudio api={api} makeClient={() => fake as unknown as EventStreamClient} />))
    // The 404 flips sessionGone → the honest recovery card surfaces with the localized hint.
    await waitFor(() => expect(screen.getByText(/This session no longer exists/i)).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Start new build' })).toBeInTheDocument()
  })

  it('clicking "Start new build" clears the card and drops the ?s= deep-link', async () => {
    const api = new ApiClient('', vi.fn(deepLinkFetch('sgone', 404, { error: 'not found' })))
    const fake = new FakeStream()
    render(wrap(<ChatStudio api={api} makeClient={() => fake as unknown as EventStreamClient} />))
    await waitFor(() => expect(screen.getByText(/This session no longer exists/i)).toBeInTheDocument())

    await userEvent.click(screen.getByRole('button', { name: 'Start new build' }))
    // newChat() resets to a fresh idle conversation: gone-card disappears, ?s= is dropped.
    await waitFor(() => expect(screen.queryByText(/This session no longer exists/i)).toBeNull())
    expect(window.location.search).toBe('')
  })

  it('does NOT show the card for a non-404 error (500) — transient behavior preserved', async () => {
    const api = new ApiClient('', vi.fn(deepLinkFetch('sgone', 500, { error: 'boom' })))
    const fake = new FakeStream()
    render(wrap(<ChatStudio api={api} makeClient={() => fake as unknown as EventStreamClient} />))
    // Let the failing getSession settle, then assert the card never appeared (silent on 5xx).
    await waitFor(() => expect(fake.connectedUrl).toBe('/sessions/sgone/events'))
    await Promise.resolve()
    expect(screen.queryByText(/This session no longer exists/i)).toBeNull()
  })

  it('does NOT show the card when getSession succeeds (valid session)', async () => {
    const api = new ApiClient('', vi.fn(deepLinkFetch('sgone', 200, { id: 'sgone', status: 'done', version: 1 })))
    const fake = new FakeStream()
    render(wrap(<ChatStudio api={api} makeClient={() => fake as unknown as EventStreamClient} />))
    await waitFor(() => expect(fake.connectedUrl).toBe('/sessions/sgone/events'))
    await Promise.resolve()
    expect(screen.queryByText(/This session no longer exists/i)).toBeNull()
  })
})

const viewWith = (p: Partial<SessionView>): SessionView => ({ ...emptyView('s1'), ...p })

// ── PREVIEW UNGATED FROM VERIFICATION (owner 2026-06-11): "if Proto wrote code, the user must ALWAYS
//    be able to preview it." canRun keys on CODE PRESENCE + a settled-enough status (every TERMINAL
//    status + awaiting_critic_resolution + awaiting_push_confirm), NOT on verification. A session parked
//    at verify_failed / awaiting_critic_resolution / cancelled WITH code used to offer no ▶ Run anywhere
//    (a dead end). It must now offer Run; a session mid-building WITHOUT code must NOT. The unverified
//    chip stays independent (honesty); trust/publish stay gated on done. ──
describe('ChatStudio — preview ungated from verification (Run keys on code presence + settled status)', () => {
  beforeEach(() => { localStorage.clear() })
  afterEach(() => { window.history.replaceState({}, '', '/') })

  const CODE = { files: [{ filePath: 'index.html', content: '<html/>' }] }

  /** Deep-link a session whose getSession resolves to `body` (with code/status). The drawer is closed
   *  by default; the Run button lives in its (aria-hidden) subtree, so we query with `hidden: true`. */
  function previewFetch(id: string, body: Record<string, unknown>): (path: string) => Promise<Response> {
    return async (path: string) => {
      if (path.endsWith('/sessions/mine')) return { ok: true, status: 200, json: async () => ([{ id, idea: 'an app', status: body.status, verified: body.verified }]), text: async () => '' } as unknown as Response
      if (path.endsWith(`/sessions/${id}/log`)) return { ok: true, status: 200, json: async () => ({ events: [], head: 0 }), text: async () => '' } as unknown as Response
      if (path.endsWith(`/sessions/${id}`)) return { ok: true, status: 200, json: async () => body, text: async () => '' } as unknown as Response
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response
    }
  }

  /** Render a deep-linked session + return its drawer once the snapshot effect has settled. */
  async function renderDeepLink(id: string, body: Record<string, unknown>) {
    window.history.replaceState({}, '', `/?s=${id}`)
    const api = new ApiClient('', vi.fn(previewFetch(id, body)))
    const fake = new FakeStream()
    render(wrap(<ChatStudio api={api} makeClient={() => fake as unknown as EventStreamClient} />))
    const drawer = await screen.findByTestId('preview-drawer')
    // Settle the getSession snapshot effect (codeFiles/backendStatus drive canRun) before asserting:
    // the RunBlock subscribes the stream once the active run is seeded, so connectedUrl pins "settled".
    await waitFor(() => expect(fake.connectedUrl).toBe(`/sessions/${id}/events`))
    return drawer
  }

  // PreviewPanel renders the SAME "Run app" control on TWO surfaces while there's no live URL (the header
  // pill AND the empty-state CTA), so getAllByRole — a singular getByRole would throw "multiple elements".
  const runButtons = (drawer: HTMLElement): HTMLElement[] =>
    within(drawer).queryAllByRole('button', { name: /Run app/i, hidden: true })

  it('offers ▶ Run for a verify_failed session WITH code (the dead-end this fixes)', async () => {
    const drawer = await renderDeepLink('svf', { id: 'svf', status: 'verify_failed', verified: false, version: 3, code: CODE })
    // The Run button(s) live in the (aria-hidden, closed) drawer — query the a11y tree with hidden:true.
    await waitFor(() => expect(runButtons(drawer).length).toBe(2)) // BOTH surfaces: header pill + empty-state CTA
  })

  it('offers ▶ Run for an awaiting_critic_resolution session WITH code', async () => {
    const drawer = await renderDeepLink('sacr', { id: 'sacr', status: 'awaiting_critic_resolution', verified: false, version: 1, code: CODE })
    await waitFor(() => expect(runButtons(drawer).length).toBe(2)) // BOTH surfaces: header pill + empty-state CTA
  })

  it('offers ▶ Run for a cancelled session WITH code', async () => {
    const drawer = await renderDeepLink('scan', { id: 'scan', status: 'cancelled', verified: false, version: 1, code: CODE })
    await waitFor(() => expect(runButtons(drawer).length).toBe(2)) // BOTH surfaces: header pill + empty-state CTA
  })

  it('does NOT offer Run for a mid-building session WITHOUT code (nothing to preview yet)', async () => {
    const drawer = await renderDeepLink('sbuild', { id: 'sbuild', status: 'building', version: 1 })
    // No code → no Run button anywhere in the drawer, even after the snapshot settles (connectedUrl set).
    expect(runButtons(drawer).length).toBe(0)
  })

  it('does NOT offer Run for an awaiting_spec_approval session (pre-code mid-flight) even if a status leaks', async () => {
    // Belt-and-suspenders: a pre-code status is NOT in PREVIEWABLE_STATUSES; with no code files it must
    // never offer Run (the code-presence guard AND the status guard both fail here).
    const drawer = await renderDeepLink('sspec', { id: 'sspec', status: 'awaiting_spec_approval', version: 1 })
    expect(runButtons(drawer).length).toBe(0)
  })

  it('does NOT widen trust/publish: they stay HIDDEN for a non-done session WITH code (gated on done)', async () => {
    const drawer = await renderDeepLink('svf3', { id: 'svf3', status: 'verify_failed', verified: false, version: 1, code: CODE })
    // Run is offered (preview ungated)…
    await waitFor(() => expect(runButtons(drawer).length).toBe(2)) // BOTH surfaces: header pill + empty-state CTA
    // …but TrustReportCard / PublishButton are still done-gated, so neither surfaces for verify_failed —
    // proving canRun was widened WITHOUT widening isDone (the sacred trust/publish semantics hold).
    expect(within(drawer).queryByText(/Trust report|Güven raporu/i)).toBeNull()
    expect(within(drawer).queryByText(/Publish to your server|Sunucuna yayınla/i)).toBeNull()
  })

  // VERIFICATION HONESTY in the ungated states (review MED): the live view only learns `verified`
  // from the SSE done fold — an evicted-replay reopen would boot a runnable app with no verification
  // wording. The snapshot effect now seeds it from the DURABLE truth (isVerified = VerifyToken).
  it('a reopened verify_failed session shows the worded UNVERIFIED chip (snapshot-seeded honesty)', async () => {
    const drawer = await renderDeepLink('svhon', { id: 'svhon', status: 'verify_failed', version: 2, code: CODE })
    // No verifyToken on the snapshot → isVerified=false → the worded chip renders "unverified".
    await waitFor(() => expect(within(drawer).getByText('unverified')).toBeInTheDocument())
  })

  it('a reopened DONE session with a VerifyToken shows the worded VERIFIED chip even with an empty replay', async () => {
    const drawer = await renderDeepLink('svok', {
      id: 'svok', status: 'done', version: 4, code: CODE,
      verifyToken: { sessionId: 'svok', codeDigest: 'd', testsRun: 3, passed: true, at: 't' },
    })
    await waitFor(() => expect(within(drawer).getByText('verified')).toBeInTheDocument())
  })

  it('does NOT seed the chip mid-build: a building snapshot leaves view.verified untouched', async () => {
    const drawer = await renderDeepLink('sbmid', { id: 'sbmid', status: 'building', version: 1, code: CODE })
    await new Promise(r => setTimeout(r, 0))
    expect(within(drawer).queryByText('unverified')).toBeNull()
    expect(within(drawer).queryByText('verified')).toBeNull()
  })
})

describe('RunPipeline sessionGone precedence', () => {
  it('suppresses the connectionGone banner when sessionGone is true', () => {
    const gone = viewWith({ status: 'running', connectionGone: true })
    const { rerender } = render(wrap(<RunPipeline view={gone} sessionGone />))
    // Session is genuinely gone → the gone-card upstream is the recovery path, so the transport
    // "Reload" banner is NOT rendered (it would just hit the same 404).
    expect(screen.queryByText(/Live updates stopped|live updates stopped/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /Reload/i })).toBeNull()
    // But WITHOUT sessionGone (transient transport loss), the banner still renders.
    rerender(wrap(<RunPipeline view={gone} sessionGone={false} />))
    expect(screen.getByRole('button', { name: /Reload/i })).toBeInTheDocument()
  })

  it('suppresses the reconnecting banner when sessionGone is true', () => {
    const lost = viewWith({ status: 'running', connectionLost: true })
    const { rerender } = render(wrap(<RunPipeline view={lost} sessionGone />))
    expect(screen.queryByText(/reconnecting/i)).toBeNull()
    rerender(wrap(<RunPipeline view={lost} sessionGone={false} />))
    expect(screen.getByText(/reconnecting/i)).toBeInTheDocument()
  })
})

describe('ChatStudio — P0-1 single spec approval (chat-approved spec seed)', () => {
  beforeEach(() => { localStorage.clear(); window.history.replaceState({}, '', '/') })
  afterEach(() => { window.history.replaceState({}, '', '/') })

  /** A fetch that: returns an akis-spec reply for the chat, an empty history list, and a created
   *  building session for POST /sessions — capturing the POST body so the test can assert the seed. */
  function studioFetch(captured: { body?: unknown }): (path: string, init?: RequestInit) => Promise<Response> {
    const reply = "Here's a spec 👇\n```akis-spec\n# TODO App\nA list.\n```"
    return async (path: string, init?: RequestInit) => {
      if (path.endsWith('/sessions/mine')) return { ok: true, status: 200, json: async () => [], text: async () => '' } as unknown as Response
      if (path.endsWith('/api/chat/stream')) return { ok: false, status: 404, json: async () => ({}), text: async () => '' } as unknown as Response // force non-stream fallback
      if (path.endsWith('/api/chat')) return { ok: true, status: 200, json: async () => ({ reply }), text: async () => '' } as unknown as Response
      if (path.endsWith('/sessions') && init?.method === 'POST') {
        captured.body = JSON.parse(String(init.body))
        return { ok: true, status: 201, json: async () => ({ id: 'snew', status: 'building', idea: '# TODO App\nA list.', version: 1 }), text: async () => '' } as unknown as Response
      }
      // getSession after the build starts: a building (non-terminal) session.
      if (path.endsWith('/sessions/snew')) return { ok: true, status: 200, json: async () => ({ id: 'snew', status: 'building', version: 1 }), text: async () => '' } as unknown as Response
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response
    }
  }

  it('passes the chat-approved spec as a {title, body} seed to POST /sessions (no second approve)', async () => {
    const captured: { body?: unknown } = {}
    const api = new ApiClient('', vi.fn(studioFetch(captured)))
    const fake = new FakeStream()
    render(wrap(<ChatStudio api={api} makeClient={() => fake as unknown as EventStreamClient} />))

    // Ask AKIS → a SpecCard with "Approve & Build" appears. The composer submit is labeled "Ask".
    await userEvent.type(screen.getByLabelText(/Ask AKIS/i), 'todo app')
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))
    const buildBtn = await screen.findByRole('button', { name: 'Approve & Build' })
    await userEvent.click(buildBtn)

    // The POST body carried the AUTHORITATIVE seed: the title is the spec heading, body is the spec.
    await waitFor(() => expect(captured.body).toBeDefined())
    const body = captured.body as { idea: string; spec?: { title: string; body: string } }
    expect(body.spec).toBeDefined()
    expect(body.spec!.title).toBe('TODO App')
    expect(body.spec!.body).toContain('# TODO App')
  })

  it('sends the PRE-BUILD conversation (the spec-shaping user/assistant turns) to POST /sessions so a cross-device reopen rehydrates them', async () => {
    // CONVERSATION-LOST FIX (cross-device): the pre-build turns are seeded onto session.chat at
    // build start. historyForApi skips the greeting + run markers + error rows, so the server only
    // ever receives the genuine user/assistant exchange that shaped the spec.
    const captured: { body?: unknown } = {}
    const api = new ApiClient('', vi.fn(studioFetch(captured)))
    const fake = new FakeStream()
    render(wrap(<ChatStudio api={api} makeClient={() => fake as unknown as EventStreamClient} />))

    await userEvent.type(screen.getByLabelText(/Ask AKIS/i), 'todo app')
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Approve & Build' }))

    await waitFor(() => expect(captured.body).toBeDefined())
    const body = captured.body as { idea: string; chat?: { role: string; content: string }[] }
    expect(body.chat).toBeDefined()
    // The user's spec-shaping turn rides along; the greeting (an assistant turn) is dropped.
    expect(body.chat!).toContainEqual({ role: 'user', content: 'todo app' })
    expect(body.chat!.some(t => t.role === 'assistant' && t.content.includes('akis-spec'))).toBe(true)
    expect(body.chat!.some(t => t.content.includes('I’m AKIS'))).toBe(false) // greeting excluded
  })

  it("P1-6: 'New build' on a NON-TERMINAL run cancels it (api.cancel) before clearing", async () => {
    const captured: { body?: unknown } = {}
    const api = new ApiClient('', vi.fn(studioFetch(captured)))
    const cancelRun = vi.spyOn(api, 'cancelRun').mockResolvedValue({} as never)
    const fake = new FakeStream()
    render(wrap(<ChatStudio api={api} makeClient={() => fake as unknown as EventStreamClient} />))

    await userEvent.type(screen.getByLabelText(/Ask AKIS/i), 'todo app')
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Approve & Build' }))
    // The build started → a non-terminal (building) session. getSession resolves backendStatus.
    await waitFor(() => expect(captured.body).toBeDefined())

    // 'New build' must STOP the running pipeline (not orphan it) before resetting.
    await userEvent.click(await screen.findByRole('button', { name: 'New build' }))
    await waitFor(() => expect(cancelRun).toHaveBeenCalledWith('snew'))
  })
})

// ── MOBILE 390px: the preview rail is reachable via the drawer's persistent FAB (the old mobile
//    Chat/Preview tablist was retired in favor of the slide-in drawer + floating "Open preview"). ──
describe('ChatStudio — mobile preview reachability via the drawer FAB', () => {
  beforeEach(() => { localStorage.clear(); window.history.replaceState({}, '', '/') })
  afterEach(() => { window.history.replaceState({}, '', '/') })

  /** A studio fetch that creates a session for one approval whose getSession resolves DONE with code. */
  function runFetch(): (path: string, init?: RequestInit) => Promise<Response> {
    const reply = "Here's a spec 👇\n```akis-spec\n# TODO App\nA list.\n```"
    return async (path: string, init?: RequestInit) => {
      if (path.endsWith('/sessions/mine')) return { ok: true, status: 200, json: async () => [], text: async () => '' } as unknown as Response
      if (path.endsWith('/api/chat/stream')) return { ok: false, status: 404, json: async () => ({}), text: async () => '' } as unknown as Response
      if (path.endsWith('/api/chat')) return { ok: true, status: 200, json: async () => ({ reply }), text: async () => '' } as unknown as Response
      if (path.endsWith('/sessions') && init?.method === 'POST') return { ok: true, status: 201, json: async () => ({ id: 'sm', status: 'running', idea: '# TODO App\nA list.', version: 1 }), text: async () => '' } as unknown as Response
      if (path.endsWith('/sessions/sm')) return { ok: true, status: 200, json: async () => ({ id: 'sm', status: 'done', code: { files: [{ filePath: 'index.html', content: '<html/>' }] }, version: 2 }), text: async () => '' } as unknown as Response
      if (path.endsWith('/sessions/sm/log')) return { ok: true, status: 200, json: async () => ({ events: [], head: 0 }), text: async () => '' } as unknown as Response
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response
    }
  }

  it('there is NO mobile chat/preview tablist anymore; the drawer + its FAB appear once a run exists', async () => {
    const api = new ApiClient('', vi.fn(runFetch()))
    const fake = new FakeStream()
    render(wrap(<ChatStudio api={api} makeClient={() => fake as unknown as EventStreamClient} />))

    // Idle: no drawer yet (only mounts once a run exists).
    expect(screen.queryByTestId('preview-drawer')).toBeNull()
    expect(screen.queryByTestId('preview-fab')).toBeNull()
    // The retired mobile pane-switcher is gone.
    expect(screen.queryByRole('tablist', { name: /view/i })).toBeNull()

    await userEvent.type(screen.getByLabelText(/Ask AKIS/i), 'todo app')
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Approve & Build' }))

    // The drawer is now mounted (a sibling of the chat) with its persistent mobile FAB.
    const drawer = await screen.findByTestId('preview-drawer')
    expect(screen.getByTestId('preview-fab')).toBeInTheDocument()
    // The retired "View" pane-switcher tablist is gone.
    expect(screen.queryByRole('tablist', { name: 'View' })).toBeNull()
    // The drawer is CLOSED by default (chat-first) → its content is aria-hidden, so PreviewPanel's
    // inner tablist is correctly NOT in the a11y tree while collapsed; the edge-tab reopens it.
    expect(drawer).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByTestId('preview-edge-tab')).toBeInTheDocument()
  })
})

// ── ANCHORED MULTI-RUN: two approvals → two inline run-blocks in ONE scroll ──
describe('ChatStudio — anchored multi-run transcript', () => {
  beforeEach(() => { localStorage.clear(); window.history.replaceState({}, '', '/') })
  afterEach(() => { window.history.replaceState({}, '', '/') })

  /** A per-connect fake stream: makeClient returns a NEW instance each call (one per run-block's
   *  useLiveChat), and `latest()` is the most-recently-connected one — the ACTIVE run, since a
   *  terminal run never opens an EventSource (it folds /log instead). emit() drives that one. */
  class EmitStream {
    static created: EmitStream[] = []
    connectedUrl?: string
    private onEvent?: (e: AkisEvent, seq: number) => void
    constructor() { EmitStream.created.push(this) }
    connect(url: string, h: { onEvent: (e: AkisEvent, seq: number) => void }): void { this.connectedUrl = url; this.onEvent = h.onEvent }
    close(): void {}
    emit(e: AkisEvent, seq: number): void { this.onEvent?.(e, seq) }
  }
  const ev = (e: Partial<AkisEvent> & { kind: AkisEvent['kind'] }): AkisEvent =>
    ({ agent: 'orchestrator', laneId: 'main', sessionId: 's1', ts: 0, ...(e as object) }) as AkisEvent

  const SPEC_A = 'Spec A 👇\n\n````akis-spec\n# Run Alpha\nThe first app.\n````'
  const SPEC_B = 'Spec B 👇\n\n````akis-spec\n# Run Beta\nThe second app.\n````'

  /** A studio harness: two distinct chat specs, two created sessions (sA then sB), and getSession
   *  resolving sA WITH code (so the 2nd build base-merges) + sB without. Captures POST bodies. */
  function multiRunFetch(bodies: Record<string, unknown>[]): (path: string, init?: RequestInit) => Promise<Response> {
    let chatCalls = 0
    return async (path: string, init?: RequestInit) => {
      if (path.endsWith('/sessions/mine')) return { ok: true, status: 200, json: async () => [], text: async () => '' } as unknown as Response
      if (path.endsWith('/api/chat/stream')) return { ok: false, status: 500, json: async () => ({}), text: async () => '' } as unknown as Response
      if (path.endsWith('/api/chat')) { chatCalls++; return { ok: true, status: 200, json: async () => ({ reply: chatCalls === 1 ? SPEC_A : SPEC_B }), text: async () => '' } as unknown as Response }
      if (path.endsWith('/sessions') && init?.method === 'POST') {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        return { ok: true, status: 201, json: async () => ({ id: bodies.length === 1 ? 'sA' : 'sB', status: 'running', version: 1 }), text: async () => '' } as unknown as Response
      }
      if (path.endsWith('/sessions/sA')) return { ok: true, status: 200, json: async () => ({ id: 'sA', status: 'done', code: { files: [{ filePath: 'index.html', content: '<html/>' }] }, version: 2 }), text: async () => '' } as unknown as Response
      if (path.endsWith('/sessions/sB')) return { ok: true, status: 200, json: async () => ({ id: 'sB', status: 'running', version: 1 }), text: async () => '' } as unknown as Response
      if (path.endsWith('/sessions/sA/log') || path.endsWith('/sessions/sB/log')) return { ok: true, status: 200, json: async () => ({ events: [], head: 0 }), text: async () => '' } as unknown as Response
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response
    }
  }

  it('two approvals append TWO run-blocks in one scroll; the 2nd build base-merges sA; Stop targets the latest', async () => {
    EmitStream.created = []
    const bodies: Record<string, unknown>[] = []
    const api = new ApiClient('', vi.fn(multiRunFetch(bodies)))
    const cancelRun = vi.spyOn(api, 'cancelRun').mockResolvedValue({} as never)
    render(wrap(<ChatStudio api={api} makeClient={() => new EmitStream() as unknown as EventStreamClient} />))

    // Build A.
    await userEvent.type(screen.getByLabelText(/ask akis/i), 'first app{Enter}')
    await userEvent.click(await screen.findByRole('button', { name: 'Approve & Build' }))
    await waitFor(() => expect(bodies.length).toBe(1))
    expect(bodies[0]).not.toHaveProperty('baseSessionId')
    // ONE run-block now (each run-block renders exactly one Trust ledger).
    await waitFor(() => expect(screen.getAllByLabelText('Trust ledger')).toHaveLength(1))

    // Follow-up CHANGE → Build B. Approve the LATEST spec card.
    await userEvent.type(screen.getAllByLabelText(/ask akis/i)[0]!, 'second app{Enter}')
    const approves = await screen.findAllByRole('button', { name: 'Approve & Build' })
    await userEvent.click(approves[approves.length - 1]!)
    await waitFor(() => expect(bodies.length).toBe(2))
    // The 2nd startSession base-merges the prior (active) run that PRODUCED CODE.
    expect(bodies[1]).toMatchObject({ baseSessionId: 'sA' })

    // TWO run-blocks now live in the SAME scroll (run A is terminal, run B is active) — two ledgers.
    await waitFor(() => expect(screen.getAllByLabelText('Trust ledger').length).toBe(2))

    // Stop targets the LATEST (active) run: the active EmitStream is the last connected one (sB).
    const live = EmitStream.created[EmitStream.created.length - 1]!
    expect(live.connectedUrl).toBe('/sessions/sB/events')
    live.emit(ev({ kind: 'session', status: 'started', sessionId: 'sB' }), 1)
    const stop = await screen.findByRole('button', { name: 'Stop run' })
    await userEvent.click(stop)
    await waitFor(() => expect(cancelRun).toHaveBeenCalledWith('sB'))
    // Exactly the latest — never the older terminal run.
    expect(cancelRun).not.toHaveBeenCalledWith('sA')
  })

  it("reopen seeds ONE run-block + a clean greeting (no inherited chat) and replays its log", async () => {
    EmitStream.created = []
    // Seed an UNRELATED prior conversation; reopening must NOT inherit it.
    localStorage.setItem('akis_chat_thread', JSON.stringify([
      { role: 'user', content: 'unrelated earlier chat' },
      { role: 'assistant', content: 'unrelated earlier reply' },
    ]))
    const fetchFn = vi.fn(async (path: string) => {
      if (path.endsWith('/sessions/mine')) return { ok: true, status: 200, json: async () => ([{ id: 'sR', idea: '# Reopened App', status: 'done', verified: true }]), text: async () => '' } as unknown as Response
      if (path.endsWith('/sessions/sR/log')) return { ok: true, status: 200, json: async () => ({ events: [], head: 0 }), text: async () => '' } as unknown as Response
      if (path.endsWith('/sessions/sR')) return { ok: true, status: 200, json: async () => ({ id: 'sR', status: 'done', version: 1 }), text: async () => '' } as unknown as Response
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response
    })
    const api = new ApiClient('', fetchFn)
    render(wrap(<ChatStudio api={api} makeClient={() => new EmitStream() as unknown as EventStreamClient} />))

    await userEvent.click(await screen.findByRole('button', { name: /Recent/i })) // in-studio recent-builds dropdown
    await userEvent.click(await screen.findByRole('menuitem', { name: /Reopened App/i }))

    // Exactly ONE run-block (one trust ledger), titled by the reopened idea; the live stream connects.
    await waitFor(() => expect(screen.getByText('Reopened App')).toBeInTheDocument())
    expect(screen.getAllByLabelText('Trust ledger')).toHaveLength(1)
    await waitFor(() => expect(EmitStream.created.some(s => s.connectedUrl === '/sessions/sR/events')).toBe(true))
    // The CLEAN greeting is present; the unrelated prior chat is NOT inherited.
    expect(screen.getByText(/I’m AKIS/)).toBeInTheDocument()
    expect(screen.queryByText('unrelated earlier chat')).toBeNull()
    expect(screen.queryByText('unrelated earlier reply')).toBeNull()
  })
})

// ── PREVIEW DRAWER: push-split shell, auto-open on ready (not starting), #35 reopen suppression ──
describe('ChatStudio — preview drawer (push-split shell + auto-open on ready)', () => {
  beforeEach(() => { localStorage.clear(); window.history.replaceState({}, '', '/') })
  afterEach(() => { window.history.replaceState({}, '', '/') })

  /** Per-connect fake stream (one per run-block's useLiveChat). The most-recently-connected is the
   *  ACTIVE run (a terminal run folds /log without an EventSource); emit() drives folding on it so a
   *  test can flip the folded view's preview lifecycle (starting → ready) and assert the drawer. */
  class EmitStream {
    static created: EmitStream[] = []
    connectedUrl?: string
    private onEvent?: (e: AkisEvent, seq: number) => void
    constructor() { EmitStream.created.push(this) }
    connect(url: string, h: { onEvent: (e: AkisEvent, seq: number) => void }): void { this.connectedUrl = url; this.onEvent = h.onEvent }
    close(): void {}
    emit(e: AkisEvent, seq: number): void { this.onEvent?.(e, seq) }
  }
  const ev = (e: Partial<AkisEvent> & { kind: AkisEvent['kind'] }): AkisEvent =>
    ({ agent: 'orchestrator', laneId: 'main', sessionId: 'sd', ts: 0, ...(e as object) }) as AkisEvent

  const SPEC = "Here's a spec 👇\n```akis-spec\n# TODO App\nA list.\n```"

  /** A studio harness: one chat spec → one created RUNNING session (sd) whose getSession resolves
   *  running (so the build is live and its EmitStream is the active reporter we can emit on). */
  function drawerFetch(): (path: string, init?: RequestInit) => Promise<Response> {
    return async (path: string, init?: RequestInit) => {
      if (path.endsWith('/sessions/mine')) return { ok: true, status: 200, json: async () => [], text: async () => '' } as unknown as Response
      if (path.endsWith('/api/chat/stream')) return { ok: false, status: 404, json: async () => ({}), text: async () => '' } as unknown as Response
      if (path.endsWith('/api/chat')) return { ok: true, status: 200, json: async () => ({ reply: SPEC }), text: async () => '' } as unknown as Response
      if (path.endsWith('/sessions') && init?.method === 'POST') return { ok: true, status: 201, json: async () => ({ id: 'sd', status: 'running', idea: '# TODO App\nA list.', version: 1 }), text: async () => '' } as unknown as Response
      if (path.endsWith('/sessions/sd/log')) return { ok: true, status: 200, json: async () => ({ events: [], head: 0 }), text: async () => '' } as unknown as Response
      if (path.endsWith('/sessions/sd')) return { ok: true, status: 200, json: async () => ({ id: 'sd', status: 'running', version: 1 }), text: async () => '' } as unknown as Response
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response
    }
  }

  /** Drive a fresh build to live and return the active EmitStream (the live reporter). */
  async function startLiveBuild() {
    EmitStream.created = []
    const api = new ApiClient('', vi.fn(drawerFetch()))
    render(wrap(<ChatStudio api={api} makeClient={() => new EmitStream() as unknown as EventStreamClient} />))
    await userEvent.type(screen.getByLabelText(/ask akis/i), 'todo app')
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Approve & Build' }))
    // The active run connects its EventSource (a fresh build is live, not terminal).
    await waitFor(() => expect(EmitStream.created.some(s => s.connectedUrl === '/sessions/sd/events')).toBe(true))
    return EmitStream.created.find(s => s.connectedUrl === '/sessions/sd/events')!
  }

  it('chat is full-width (--preview-w: 0px, drawer aria-hidden) before any preview is ready', async () => {
    const live = await startLiveBuild()
    live.emit(ev({ kind: 'session', status: 'started', sessionId: 'sd' }), 1)
    // Drawer mounts (sibling) once a run exists, but stays CLOSED until a preview is ready.
    const drawer = await screen.findByTestId('preview-drawer')
    expect(drawer).toHaveAttribute('aria-hidden', 'true')
    expect(drawer).toHaveStyle({ transform: 'translateX(100%)' })
    // The shell drives the chat padding via a single CSS var, which is 0px while closed.
    expect(drawer.closest('[data-preview-shell]')!.getAttribute('style')).toContain('--preview-w: 0px')
  })

  it('does NOT auto-open while the preview is only starting', async () => {
    const live = await startLiveBuild()
    live.emit(ev({ kind: 'preview_status', status: 'starting', sessionId: 'sd' }), 1)
    // A starting frame is NOT a ready artifact → the drawer must stay closed (anti-flicker).
    const drawer = await screen.findByTestId('preview-drawer')
    await waitFor(() => expect(drawer).toHaveAttribute('aria-hidden', 'true'))
  })

  it('auto-opens the drawer when the preview becomes ready (once per run)', async () => {
    const live = await startLiveBuild()
    const drawer = await screen.findByTestId('preview-drawer')
    expect(drawer).toHaveAttribute('aria-hidden', 'true')
    // A ready frame yields an embeddable /preview/sd/ url → the drawer slides in.
    live.emit(ev({ kind: 'preview_status', status: 'ready', url: '/preview/sd/', sessionId: 'sd' }), 1)
    await waitFor(() => expect(drawer).toHaveAttribute('aria-hidden', 'false'))
    expect(drawer).toHaveStyle({ transform: 'translateX(0)' })
  })

  it('reopening a finished build does NOT auto-open the drawer (#35 drawerAutoOpened pre-seed)', async () => {
    EmitStream.created = []
    const fetchFn = vi.fn(async (path: string) => {
      if (path.endsWith('/sessions/mine')) return { ok: true, status: 200, json: async () => ([{ id: 'sR', idea: '# Reopened App', status: 'done', verified: true }]), text: async () => '' } as unknown as Response
      if (path.endsWith('/sessions/sR/log')) return { ok: true, status: 200, json: async () => ({ events: [], head: 0 }), text: async () => '' } as unknown as Response
      if (path.endsWith('/sessions/sR')) return { ok: true, status: 200, json: async () => ({ id: 'sR', status: 'done', version: 1 }), text: async () => '' } as unknown as Response
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response
    })
    const api = new ApiClient('', fetchFn)
    render(wrap(<ChatStudio api={api} makeClient={() => new EmitStream() as unknown as EventStreamClient} />))

    await userEvent.click(await screen.findByRole('button', { name: /Recent/i })) // in-card recent-builds dropdown
    await userEvent.click(await screen.findByRole('menuitem', { name: /Reopened App/i }))
    await waitFor(() => expect(screen.getByText('Reopened App')).toBeInTheDocument())
    const live = await waitFor(() => EmitStream.created.find(s => s.connectedUrl === '/sessions/sR/events')!)

    const drawer = await screen.findByTestId('preview-drawer')
    // A reopen pre-seeds drawerAutoOpened — even a fresh `ready` frame must NOT auto-open it (the
    // user reopened to read the transcript; the drawer is opened only by an explicit action).
    live.emit(ev({ kind: 'preview_status', status: 'ready', url: '/preview/sR/', sessionId: 'sR' }), 1)
    await Promise.resolve()
    await waitFor(() => expect(drawer).toHaveAttribute('aria-hidden', 'true'))
  })
})

// ── LOW-2 (no first-frame flash) + the no-run VOID FIX (owner 2026-06-10). The push-split strip
//    (`--preview-w`) is reserved ONLY when a drawer is actually rendered for a run (hasRun). A persisted
//    open:true with NO run must leave the chat full-width (else it sits shifted-left behind an empty
//    void). WITH a run, the synchronous useLayoutEffect seed makes `--preview-w` already the clamped real
//    width on the first commit (no 0→480 collapsed-drawer flash; jsdom has no ResizeObserver). ──
describe('ChatStudio — preview-w gating (no-run void fix + first-frame seed)', () => {
  beforeEach(() => { localStorage.clear(); window.history.replaceState({}, '', '/') })
  afterEach(() => { localStorage.clear(); window.history.replaceState({}, '', '/'); vi.restoreAllMocks() })

  it('does NOT reserve a push-split strip when the drawer persists open but NO run exists (no void)', () => {
    // VOID FIX: a persisted open:true with no active build must NOT pad the chat right for a drawer that
    // isn't rendered — otherwise the conversation is jammed left behind a large empty strip. With no run
    // (hasRun=false) the split var is 0px so the conversation reflows full-width and centers.
    localStorage.setItem('akis_preview_drawer', JSON.stringify({ open: true, ratio: 0.46 }))
    // jsdom returns width:0 from getBoundingClientRect by default; mock a real shell width (the only width
    // source in tests — there is no ResizeObserver in jsdom) to prove the var is 0px by GATE, not width.
    const SHELL_W = 1000
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: SHELL_W, height: 600, top: 0, left: 0, right: SHELL_W, bottom: 600, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect)
    const api = new ApiClient('', vi.fn(async () => ({ ok: true, status: 200, json: async () => [], text: async () => '' } as unknown as Response)))
    const fake = new FakeStream()
    const { container } = render(wrap(<ChatStudio api={api} makeClient={() => fake as unknown as EventStreamClient} />))
    const shell = container.querySelector('[data-preview-shell]') as HTMLElement
    expect(shell.style.getPropertyValue('--preview-w')).toBe('0px')
  })

  it('seeds --preview-w to the real width once a run exists and the drawer persists open (no collapsed-drawer flash)', async () => {
    // ANTI-FLASH: when a deep-linked build resolves (hasRun=true) with a persisted-OPEN drawer, the
    // synchronous useLayoutEffect seed means --preview-w is already the clamped real width (clampRatio(
    // 0.46, 1000) floors at MIN_PX/1000 = 0.48 → 480px) the moment the drawer renders — no 0→480 jump.
    localStorage.setItem('akis_preview_drawer', JSON.stringify({ open: true, ratio: 0.46 }))
    const SHELL_W = 1000
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: SHELL_W, height: 600, top: 0, left: 0, right: SHELL_W, bottom: 600, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect)
    window.history.replaceState({}, '', '/?s=sopen')
    const api = new ApiClient('', vi.fn(deepLinkFetch('sopen', 200, { id: 'sopen', idea: 'x', status: 'done', version: 1 })))
    const fake = new FakeStream()
    const { container } = render(wrap(<ChatStudio api={api} makeClient={() => fake as unknown as EventStreamClient} />))
    await waitFor(() =>
      expect((container.querySelector('[data-preview-shell]') as HTMLElement).style.getPropertyValue('--preview-w')).toBe('480px'),
    )
  })

  it('leaves --preview-w at 0px when the persisted drawer is CLOSED (seed only matters while open)', () => {
    localStorage.setItem('akis_preview_drawer', JSON.stringify({ open: false, ratio: 0.46 }))
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 1000, height: 600, top: 0, left: 0, right: 1000, bottom: 600, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect)
    const api = new ApiClient('', vi.fn(async () => ({ ok: true, status: 200, json: async () => [], text: async () => '' } as unknown as Response)))
    const fake = new FakeStream()
    const { container } = render(wrap(<ChatStudio api={api} makeClient={() => fake as unknown as EventStreamClient} />))
    const shell = container.querySelector('[data-preview-shell]') as HTMLElement
    // Closed → no split → full-width chat; the seed doesn't force a width open.
    expect(shell.style.getPropertyValue('--preview-w')).toBe('0px')
  })

  // ISSUE 1 (decouple) — when the drawer is CLOSED the chat-padding var (`--preview-w`) is 0px (chat goes
  // full width) BUT the drawer's OWN width var (`--preview-drawer-w`) stays the REAL ratio*width, so the
  // aside can translate its full self (✕ included) off-screen. The two vars are decoupled on the shell.
  it('keeps --preview-drawer-w at the real width while --preview-w is 0px when the drawer is CLOSED', () => {
    localStorage.setItem('akis_preview_drawer', JSON.stringify({ open: false, ratio: 0.46 }))
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 1000, height: 600, top: 0, left: 0, right: 1000, bottom: 600, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect)
    const api = new ApiClient('', vi.fn(async () => ({ ok: true, status: 200, json: async () => [], text: async () => '' } as unknown as Response)))
    const fake = new FakeStream()
    const { container } = render(wrap(<ChatStudio api={api} makeClient={() => fake as unknown as EventStreamClient} />))
    const shell = container.querySelector('[data-preview-shell]') as HTMLElement
    // Chat reflows full-width (padding var 0)…
    expect(shell.style.getPropertyValue('--preview-w')).toBe('0px')
    // …while the drawer keeps its real clamped width (clampRatio(0.46, 1000) → 480px), NOT 0 — so it slides
    // its full box (header/✕/body) off-screen instead of shrinking to nothing.
    expect(shell.style.getPropertyValue('--preview-drawer-w')).toBe('480px')
    expect(shell.style.getPropertyValue('--preview-drawer-w')).not.toBe('0px')
  })
})
