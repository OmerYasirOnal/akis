import { useState, useEffect, useRef, useCallback } from 'react'
import type { StringKey } from '../i18n/catalog.js'
import { ApiClient, ApiError } from '../api/client.js'
import { useI18n } from '../i18n/I18nContext.js'
import { useLiveChat } from './useLiveChat.js'
import { RunPipeline } from './RunPipeline.js'
import { specSeedFromMarkdown } from './buildSpec.js'
import { AkisChat } from './AkisChat.js'
import { clearThread } from './akisThread.js'
import { loadRecentBuilds, recordRecentBuild, ideaTitle, type RecentBuild } from './recentBuilds.js'
import { HistoryMenu } from './HistoryMenu.js'
import { sessionIdFromSearch } from './sessionParam.js'
import { PreviewPanel } from '../components/PreviewPanel.js'
import { TrustReportCard } from '../components/TrustReportCard.js'
import { AgentRoster } from '../components/AgentRoster.js'
import type { EventStreamClient } from '../live/EventStreamClient.js'
import type { CodeArtifact, TestEvidence, SessionStatus } from '@akis/shared'

/** The TERMINAL backend statuses — a run here is over but VIEWABLE + ITERABLE (P1-4/P1-5):
 *  done/failed/cancelled are final, and verify_failed/push_failed are parked-but-finished
 *  (the user can iterate with a follow-up message rather than be stuck). Any OTHER status is a
 *  live, in-flight run → the live cockpit. */
const TERMINAL_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  'done', 'failed', 'cancelled', 'verify_failed', 'push_failed',
])
function isTerminalStatus(s: SessionStatus | undefined): boolean {
  return s !== undefined && TERMINAL_STATUSES.has(s)
}

/**
 * The AKIS chat studio. There is ONE way to start a build: by TALKING to AKIS. The
 * conversation is a full-height, fixed-frame chat — it shapes the idea and produces a
 * one-click build-ready spec card; approving it runs the agent pipeline behind the
 * structural gates (no separate idea box, no autopilot — you stay in the conversation).
 *
 * Once a build is live, the chat gives way to the run pipeline (each agent's stage, live)
 * with the actually-running app embedded in the preview rail. Bespoke cosmic AKIS look;
 * the layout is height-bounded so the chat scrolls INSIDE its frame instead of growing the
 * page — a stable, modern surface. The preview auto-runs once a build ships.
 */
/** The "starting…" elapsed ticker as a LEAF: owns its own 1s interval + state so a tick
 *  re-renders ONLY this badge, never the parent studio tree (fixes the whole-studio flicker). */
function StartingElapsed({ t }: { t: (k: StringKey) => string }) {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const startedAt = Date.now()
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [])
  const m = Math.floor(elapsed / 60), sec = elapsed % 60
  return (
    <span className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-0.5 text-xs tabular-nums text-slate-300">
      {t('workflow.starting.elapsed')} {m.toString().padStart(2, '0')}:{sec.toString().padStart(2, '0')}
      {elapsed >= 8 && <span className="ml-2 text-amber-200">{t('workflow.starting.slow')}</span>}
    </span>
  )
}

export function ChatStudio({ api, baseUrl = '', makeClient }: { api: ApiClient; baseUrl?: string; makeClient?: () => EventStreamClient }) {
  const { t } = useI18n()
  const [sent, setSent] = useState('')               // the submitted idea (drives the thread)
  const [sessionId, setSessionId] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(true)
  const [startingSpec, setStartingSpec] = useState<string | undefined>()
  // Synchronous re-entrancy guard for the build start: `busy` is async React state, so two
  // fast clicks on "Approve & Build" both pass a `busy` check before the re-render lands and
  // create TWO sessions (one orphaned). A ref flips synchronously, so the second click is dropped.
  const startingRef = useRef(false)
  const [recent, setRecent] = useState<RecentBuild[]>(() => loadRecentBuilds())
  // Deep-link target from /?s=<id> (History page → open in Studio). Read once on mount.
  const deepLinkId = useRef<string | undefined>(typeof window !== 'undefined' ? sessionIdFromSearch(window.location.search) : undefined)
  // Prefer server-backed per-user history (persists across devices); fall back to the
  // localStorage list (loaded above) if the request fails.
  useEffect(() => {
    void api.listMySessions().then(list => {
      // Carry status + verified (P1-7) so the History menu shows the same minimal signal the
      // History page does (title + localized status + verified mark), newest-first (the API
      // returns newest-first; ts:0 keeps that order stable).
      if (list.length) setRecent(list.map(s => ({ id: s.id, idea: s.idea, ts: 0, status: s.status, verified: s.verified })))
      // Resolve the /?s= deep-link: open that build (with its idea, for the user bubble). P1-4:
      // it routes through the SAME status-driven mode as the HistoryMenu door (mode = a function of
      // the session STATUS, not which door opened it). We do NOT clear the persisted thread here
      // (unlike the explicit HistoryMenu open): a deep-link is also how a REFRESH of the active
      // build resumes (syncUrl keeps ?s= current), and that thread legitimately belongs to it.
      const id = deepLinkId.current
      if (id) {
        deepLinkId.current = undefined
        const hit = list.find(s => s.id === id)
        setSent(hit?.idea ?? ''); setSessionId(id)
      }
    }).catch(() => {
      // Even if the list fails, still honor a deep-link by id (replay rebuilds the thread).
      const id = deepLinkId.current
      if (id) { deepLinkId.current = undefined; setSent(''); setSessionId(id) }
    })
  }, [api])
  const [actionError, setActionError] = useState<string | undefined>()
  // Stale deep-link recovery: a session that NO LONGER EXISTS server-side (restart wiped the
  // in-memory store, DB loss, or external deletion) makes GET /sessions/:id return 404. We flag
  // it so the chat can offer an HONEST recovery card ("Start new build") instead of hanging on a
  // frozen view. ONLY a 404 sets this — transient network/500 errors stay silent (today's
  // behavior) so a blip never distracts the user with a false "session gone" claim.
  const [sessionGone, setSessionGone] = useState(false)

  const live = useLiveChat(sessionId, sent, api, baseUrl, makeClient)
  const status = live.view.status

  // The agent-written code (SessionState.code.files) AND the structured test evidence
  // (SessionState.testEvidence — PR #75) both live on the EXISTING GET /sessions/:id; no
  // events carry the file contents or the per-scenario detail. Re-fetch via the existing
  // client when the run progresses so the Code tab shows the real artifact and the Trust
  // tab shows the auditable evidence behind the verified result.
  const [codeFiles, setCodeFiles] = useState<CodeArtifact['files'] | undefined>(undefined)
  const [testEvidence, setTestEvidence] = useState<TestEvidence | undefined>(undefined)
  // The AUTHORITATIVE backend SessionStatus (richer than the SSE-derived view.status — it carries
  // awaiting_*/verify_failed/push_failed). One reopen RULE (P1-4) reads it: a terminal status is
  // interactive (view + iterate), a non-terminal one is the live cockpit — regardless of door.
  const [backendStatus, setBackendStatus] = useState<SessionStatus | undefined>(undefined)
  // UX honesty (B.5b): when this build EDITS a prior app (session.base set server-side), say
  // so visibly — the user must never be surprised that agents merged over existing files.
  const [editsBase, setEditsBase] = useState(false)
  useEffect(() => {
    if (!sessionId) { setCodeFiles(undefined); setTestEvidence(undefined); setEditsBase(false); setSessionGone(false); setBackendStatus(undefined); return }
    let cancelled = false
    void api.getSession(sessionId)
      .then(s => { if (!cancelled) { setCodeFiles(s.code?.files); setTestEvidence(s.testEvidence); setEditsBase(!!s.base); setBackendStatus(s.status); setSessionGone(false) } })
      .catch(e => {
        if (cancelled) return
        // A 404 means the session is genuinely GONE (server restart wiped the in-memory store,
        // DB loss, external deletion) → offer the honest recovery card. Any OTHER error (network,
        // 500) keeps today's silent behavior: Code/Trust tabs stay empty, no false "gone" claim.
        if (ApiError.is(e) && e.status === 404) setSessionGone(true)
      })
    return () => { cancelled = true }
    // live.view.connectionGone in the deps (Opus review M1): the LIVE frozen-tab case — a
    // silent server restart emits no status change, so the 404 probe must re-run when the
    // stream exhausts its reconnects; that probe is what flips the honest gone-card on.
  }, [sessionId, status, api, live.view.connectionGone])

  // The single build path: the chat-authored spec becomes a session via the UNCHANGED
  // startSession → the same 4 structural gates + pipeline + History. The ONLY caller is the
  // Chat-to-Build approval (the SpecCard's "Approve & Build"), so every build flows through
  // the conversation — there is no other entry point.
  /** Keep the address bar's ?s= deep-link pointing at the ACTIVE session (refresh-safe). */
  const syncUrl = (id: string): void => {
    if (typeof window !== 'undefined') window.history.replaceState({}, '', `${window.location.pathname}?s=${id}`)
  }
  const startBuild = async (v: string): Promise<void> => {
    const idea = v.trim(); if (!idea || busy || startingRef.current) return
    startingRef.current = true
    setBusy(true); setActionError(undefined); setStartingSpec(idea)
    try {
      // Follow-up CHANGES edit the prior app (Phase B.5): when the prior session PRODUCED
      // CODE, the next approved spec EDITS that app (baseSessionId → agents see + merge over
      // the existing files) instead of regenerating. The condition mirrors the backend's own
      // guard (prior.code?.files.length — sessions.routes) via the already-fetched codeFiles,
      // so a verify_failed/push_failed run with real code is editable too — not just 'done'.
      // "New build" resets sessionId (and codeFiles), so a fresh conversation starts from zero.
      const baseId = sessionId && codeFiles?.length ? sessionId : undefined
      // P0-1: the chat-approved spec is AUTHORITATIVE — `idea` here IS the spec text the SpecCard
      // rendered + the human approved. Pass it as the spec seed so the backend uses it as-is and
      // auto-satisfies Gate 1 (still minted server-side via the approvalAuthority); the pipeline
      // then opens already at spec-approved with NO second 'Approve spec' click. The single
      // human spec-approval moment is the SpecCard's "Approve & Build".
      const s = await api.startSession(idea, undefined, baseId, specSeedFromMarkdown(idea))
      setSent(idea); setSessionId(s.id); setStartingSpec(undefined)
      syncUrl(s.id) // keep the ?s= deep-link current (audit gap: a refresh mid-FOLLOW-UP reopened the prior session)
      setRecent(recordRecentBuild({ id: s.id, idea, ts: Date.now() }))
    } catch (e) { setActionError(ApiError.is(e) ? `${e.code ?? 'error'}: ${e.message}` : String(e)); setStartingSpec(undefined) }
    finally { setBusy(false); startingRef.current = false }
  }
  /** Re-open a past build (BOTH History doors route here — HistoryMenu directly, the /?s= deep-link
   *  via the mount effect). useLiveChat replays /log + /events to rebuild the run; the inline
   *  pipeline + composer render in ONE conversation surface (P0-3). The single reopen RULE (P1-4)
   *  is status-driven, NOT door-driven: a terminal run is interactive (view + iterate), a
   *  non-terminal one is the live cockpit. We drop the prior conversation's persisted thread so a
   *  reopened build never inherits an UNRELATED chat — AkisChat re-seeds a clean greeting and the
   *  composer is ready for a follow-up that EDITS this app (the base-merge start path). */
  const openSession = (b: RecentBuild): void => {
    setActionError(undefined); setStartingSpec(undefined); clearThread()
    setSent(b.idea); setSessionId(b.id); setBackendStatus(undefined); syncUrl(b.id)
  }
  // Stable across renders (only closes over React's stable setters), so the gate callbacks built
  // on it keep a stable identity too — which is what lets memo(RunPipeline) actually hold when the
  // studio re-renders for a reason unrelated to the live view (e.g. toggling the preview rail).
  const act = useCallback(async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true); setActionError(undefined)
    try { await fn() } catch (e) { setActionError(ApiError.is(e) ? `${e.code ?? 'error'}: ${e.message}` : String(e)) } finally { setBusy(false) }
  }, [])
  // Approve the spec gate, then KICK the run — but do NOT await the run. The /run request stays
  // open for the WHOLE pipeline (minutes), so awaiting it under `busy` would grey out every
  // control — Stop, gates, recovery, Run-app — for the entire build (the "a slow request greys
  // out everything" trap). Fire-and-forget: the SSE stream drives all subsequent state; only a
  // REJECTED start (e.g. a 409) is surfaced as a non-blocking note.
  const approve = useCallback((): Promise<void> => act(async () => {
    if (!sessionId) return
    await api.approve(sessionId)
    void api.run(sessionId).catch(e => setActionError(ApiError.is(e) ? `${e.code ?? 'error'}: ${e.message}` : String(e)))
  }), [act, api, sessionId])
  const confirm = useCallback((): Promise<void> => act(async () => { if (sessionId) await api.confirm(sessionId) }), [act, api, sessionId])
  // Localized note for a failed/unsupported preview boot (carries the backend's short reason).
  const previewFailNote = (e: { status: 'starting' | 'ready' | 'failed' | 'stopped' | 'unsupported'; reason?: string }): string =>
    t(e.status === 'unsupported' ? 'preview.unsupported' : 'preview.failed') + (e.reason ? `: ${e.reason}` : '')
  const runApp = (): Promise<void> => act(async () => {
    if (!sessionId) return
    // Inspect the resolved entry: a failed/unsupported boot is surfaced (never silently dropped).
    const e = await api.startPreview(sessionId)
    if (e.status === 'failed' || e.status === 'unsupported') setActionError(previewFailNote(e))
  })
  const newChat = (): void => {
    // P1-6: 'New build' on a NON-TERMINAL run must STOP that run, not orphan it. We cancel the
    // backend pipeline (api.cancel → Orchestrator.cancel, which only sets 'cancelled' and NEVER
    // mints a token — strictly gate-SAFER) BEFORE clearing local state, so leaving a live build
    // doesn't leave it running headless. Fire-and-forget: a 409 from an already-terminal run is
    // swallowed (nothing to stop). A terminal session needs no cancel.
    if (sessionId && !isTerminalStatus(backendStatus)) {
      void api.cancelRun(sessionId).catch(() => { /* already terminal / transient — nothing to stop */ })
    }
    // Clear the stale-session flag FIRST so the gone-card condition (sessionGone && sessionId)
    // transitions cleanly from true→false in the SAME render React batches — no flicker of both
    // a fresh chat AND the gone-card before the next getSession effect run.
    setSessionGone(false)
    setSessionId(undefined); setSent(''); setActionError(undefined); setStartingSpec(undefined); setBackendStatus(undefined)
    // Start a fresh conversation: drop the persisted thread so AkisChat re-seeds the greeting.
    clearThread()
    // Drop a stale /?s= deep-link from the address bar so a refresh starts clean.
    if (typeof window !== 'undefined' && window.location.search) window.history.replaceState({}, '', window.location.pathname)
  }

  // Auto-run the local preview once a build ships, so the app appears live with no
  // extra click (once per session; the user can re-run from the rail). Best-effort.
  const autoRan = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (sessionId && status === 'done' && autoRan.current !== sessionId) {
      autoRan.current = sessionId
      // Inspect the resolved entry: surface a failed/unsupported boot as a non-blocking note
      // instead of fully swallowing it (still don't crash on a rejected request).
      void api.startPreview(sessionId)
        .then(e => { if (e.status === 'failed' || e.status === 'unsupported') setActionError(previewFailNote(e)) })
        .catch(() => { /* network reject — surfaced via preview_status / manual run */ })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, status, api])

  const canRun = !!sessionId && (status === 'done' || live.view.verified !== undefined)
  // Honest recovery for a DELETED session (getSession 404): instead of a frozen view, a compact
  // amber card says the session is gone and offers a one-click "Start new build" (reuses newChat).
  // role="alert" so it's announced; gated by sessionId so an idle chat never shows it.
  const staleSessionCard = sessionGone && sessionId ? (
    <section role="alert" className="rounded-2xl border border-amber-400/25 bg-amber-400/[0.06] p-3 text-sm text-slate-200 shadow-[0_0_30px_rgba(251,191,36,0.1)]">
      <div className="flex flex-col gap-2">
        <div className="font-semibold text-slate-100">{t('session.gone.hint')}</div>
        <button
          onClick={newChat}
          className="w-fit rounded-md bg-gradient-to-r from-amber-400 to-[#07D1AF] px-3 py-1.5 text-sm font-semibold text-slate-900 shadow-[0_0_14px_rgba(251,191,36,0.3)] hover:shadow-[0_0_16px_rgba(251,191,36,0.4)] disabled:opacity-40"
        >
          {t('session.gone.action')}
        </button>
      </div>
    </section>
  ) : null
  const startingWorkflowCard = startingSpec ? (
    <section role="status" className="rounded-2xl border border-teal-400/25 bg-teal-400/[0.06] p-3 text-sm text-slate-200 shadow-[0_0_30px_rgba(7,209,175,0.1)]">
      {/* The 1s elapsed ticker lives in a LEAF component (StartingElapsed) so its per-second
          re-render touches ONLY the badge — not the whole studio (the flicker the user saw
          was this timer living on ChatStudio state and re-rendering the entire tree each tick). */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 animate-pulse rounded-full bg-[#07D1AF]" aria-hidden />
          <span className="font-semibold text-teal-100">{t('workflow.starting.title')}</span>
        </div>
        <StartingElapsed t={t} />
      </div>
      <div className="mt-1 text-xs text-slate-400">{t('workflow.starting.body')}</div>
    </section>
  ) : null
  const workflowCard = sessionId ? (
    // FRAMELESS by design (user feedback): the run is part of THE SAME conversation — no
    // bordered sub-panel, no chat-in-chat. A subtle divider marks the transition instead.
    <section className="border-t border-white/5 pt-3">
      {/* The build's title (the idea/spec's first line) — so a REOPENED run shows WHAT it is in
          the one conversation surface, where the nested ChatThread idea-bubble used to (P0-2/P0-3). */}
      {ideaTitle(sent) && (
        <div className="mb-2 truncate text-sm font-semibold text-slate-100" title={sent}>{ideaTitle(sent)}</div>
      )}
      {/* Edit-mode disclosure (B.5b): this build MERGES over a prior app — never a surprise. */}
      {editsBase && (
        <div className="mb-2 inline-flex items-center gap-1.5 rounded-md border border-violet-400/30 bg-violet-400/[0.08] px-2 py-0.5 text-[11px] font-medium text-violet-200">
          <span aria-hidden>🔁</span> {t('pipeline.editsBase')}
        </div>
      )}
      {/* P0-2: NO nested 'Live agent activity' ChatThread (chat-in-chat). The canonical run
          representation is the inline pipeline strip (5 step nodes + AgentRoster + summary line)
          below — one conversation, not a second one nested inside it. */}
      <RunPipeline
        view={live.view}
        onApprove={approve}
        onConfirm={confirm}
        busy={busy}
        api={api}
        sessionGone={sessionGone}
      />
    </section>
  ) : null

  // Shared frame header: the live agent roster + history access (+ New chat once a run exists).
  const header = (
    <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-2">
      <AgentRoster view={live.view} />
      <div className="flex shrink-0 items-center gap-2">
        <HistoryMenu builds={recent} onOpen={openSession} />
        {sessionId && <button onClick={newChat} className="shrink-0 rounded border border-white/10 px-2 py-0.5 text-xs text-slate-400 hover:text-slate-200">{t('chat.new')}</button>}
      </div>
    </div>
  )

  // Height-bounded so the chat / pipeline scroll INSIDE the frame instead of growing the
  // page (stable, no jump). Fixed to the viewport on desktop; a tall min-height on small
  // screens where the header wraps. The conversation stays the primary surface: approving
  // a spec inserts the live workflow into the same chat context, while preview lives in the rail.
  return (
    <div className="flex min-h-[32rem] flex-col lg:h-[calc(100dvh-8.5rem)]">
      {sessionId ? (
        <div className={`grid min-h-0 flex-1 gap-6 ${previewOpen ? 'lg:grid-cols-[minmax(0,1fr)_minmax(30rem,42%)] xl:grid-cols-[minmax(0,1fr)_minmax(34rem,46%)]' : 'lg:grid-cols-[minmax(0,1fr)_4rem]'}`}>
          {/* P0-3: ONE render + ONE scroll. Live AND reopened render the run the SAME way — the
              inline pipeline (workflowCard) inside the SINGLE AkisChat conversation surface, which
              owns the only vertical scroll. No separate reopened overflow panel, no stacked scroll
              containers. P1-5: the composer is ALWAYS present, so a reopened TERMINAL build can be
              iterated with a follow-up (which EDITS the prior app via the base-merge start path),
              not just abandoned for a 'New build'. */}
          <section className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02] shadow-[0_0_60px_rgba(124,58,237,0.06)] backdrop-blur-sm">
            {header}
            <div className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col gap-3 px-4 py-4 xl:max-w-5xl">
              {actionError && <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{actionError}</div>}
              {/* Stale deep-link recovery takes VISUAL precedence above the chat/pipeline: a
                  deleted session's honest path is "Start new build", not the frozen pipeline. */}
              {staleSessionCard}
              <AkisChat api={api} building={busy} builtSpec={sent} onBuild={(spec) => void startBuild(spec)} workflow={sessionGone ? undefined : workflowCard} />
            </div>
          </section>

          {/* Live preview rail — the actually-running app */}
          <aside className={`min-h-0 overflow-y-auto rounded-2xl border border-white/10 bg-white/[0.02] backdrop-blur-sm ${previewOpen ? 'p-4' : 'p-2'}`}>
            <div className={`mb-2 flex ${previewOpen ? 'justify-end' : 'justify-center'}`}>
              <button
                type="button"
                onClick={() => setPreviewOpen(v => !v)}
                aria-label={t(previewOpen ? 'preview.collapse' : 'preview.expand')}
                className="rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1 text-xs text-slate-300 hover:bg-white/[0.08] hover:text-slate-100"
              >
                {previewOpen ? '›' : '‹'}
              </button>
            </div>
            {previewOpen ? (
              <>
                {sessionId && status === 'done' && <TrustReportCard sessionId={sessionId} api={api} />}
                <PreviewPanel view={live.view} onRun={() => void runApp()} busy={busy} canRun={canRun} files={codeFiles} testEvidence={testEvidence} actionError={actionError} />
              </>
            ) : (
              <button
                type="button"
                onClick={() => setPreviewOpen(true)}
                className="flex min-h-28 w-full flex-col items-center justify-center gap-2 rounded-xl border border-white/10 bg-black/30 px-2 text-center text-xs text-slate-300 hover:border-teal-400/30 hover:text-teal-200"
              >
                <span aria-hidden>▣</span>
                <span>{t('preview.collapsed')}</span>
                {live.view.verified !== undefined && (
                  <span className={live.view.verified ? 'text-emerald-300' : 'text-slate-400'}>
                    {live.view.verified ? t('preview.verified') : t('preview.unverified')}
                  </span>
                )}
              </button>
            )}
          </aside>
        </div>
      ) : (
        // Idle: one full-height conversation, centered for readability. AkisChat owns the
        // input (pinned at the bottom) and scrolls internally; approving the spec card it
        // produces is the only way to start a build.
        <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02] shadow-[0_0_60px_rgba(124,58,237,0.06)] backdrop-blur-sm">
          {header}
          <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-3 px-4 py-4 xl:max-w-4xl">
            {actionError && <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{actionError}</div>}
            <div className="min-h-0 flex-1">
              <AkisChat api={api} building={busy} onBuild={(spec) => void startBuild(spec)} workflow={startingWorkflowCard} />
            </div>
          </div>
        </section>
      )}
    </div>
  )
}
