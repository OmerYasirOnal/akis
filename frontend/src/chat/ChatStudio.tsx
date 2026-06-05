import { useState, useEffect, useRef, useCallback } from 'react'
import type { StringKey } from '../i18n/catalog.js'
import { ApiClient, ApiError } from '../api/client.js'
import { useI18n } from '../i18n/I18nContext.js'
import { specSeedFromMarkdown } from './buildSpec.js'
import { AkisChat } from './AkisChat.js'
import { clearThread, saveThread, type ThreadNode } from './akisThread.js'
import { loadRecentBuilds, recordRecentBuild, type RecentBuild } from './recentBuilds.js'
import { HistoryMenu } from './HistoryMenu.js'
import { sessionIdFromSearch } from './sessionParam.js'
import { PreviewPanel } from '../components/PreviewPanel.js'
import { TrustReportCard } from '../components/TrustReportCard.js'
import { PublishButton } from '../components/PublishButton.js'
import { AgentRoster } from '../components/AgentRoster.js'
import { emptyView } from '../live/viewModel.js'
import type { EventStreamClient } from '../live/EventStreamClient.js'
import type { SessionView } from '../live/types.js'
import type { CodeArtifact, TestEvidence, SessionStatus, PublishRecord } from '@akis/shared'

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
  // ANCHORED MULTI-RUN: the run list now lives IN the chat thread (run markers), so the studio no
  // longer tracks one render sessionId. It tracks the ACTIVE run id (the latest build) for Stop,
  // snapshot targeting (getSession), the right-rail preview/trust/publish and base-merge. Older
  // runs are terminal blocks inside the spine.
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>()
  // The active run's idea/spec text (for recentBuilds + base-merge); follows the active run.
  const [activeIdea, setActiveIdea] = useState('')
  const [busy, setBusy] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(true)
  const [startingSpec, setStartingSpec] = useState<string | undefined>()
  // The active run's folded live view, reported UP by its RunBlock (exactly ONE reporter — the
  // active run — so no shared per-event setState storm). Drives the header roster + the right rail.
  const [activeView, setActiveView] = useState<SessionView>(() => emptyView(''))
  // Bumping this key REMOUNTS AkisChat so it re-reads the (re-seeded/cleared) thread from storage —
  // how "new build" and "reopen" reset/seed the spine without AkisChat owning that lifecycle.
  const [threadKey, setThreadKey] = useState(0)
  // Synchronous re-entrancy guard for the build start: `busy` is async React state, so two
  // fast clicks on "Approve & Build" both pass a `busy` check before the re-render lands and
  // create TWO sessions (one orphaned). A ref flips synchronously, so the second click is dropped.
  const startingRef = useRef(false)
  const [recent, setRecent] = useState<RecentBuild[]>(() => loadRecentBuilds())
  // Deep-link target from /?s=<id> (History page → open in Studio). Read once on mount.
  const deepLinkId = useRef<string | undefined>(typeof window !== 'undefined' ? sessionIdFromSearch(window.location.search) : undefined)
  const [actionError, setActionError] = useState<string | undefined>()
  // Stale recovery: a session that NO LONGER EXISTS server-side (restart wiped the in-memory store,
  // DB loss, external deletion) makes GET /sessions/:id return 404. Drives the rail behavior (hide
  // preview/trust/publish); the VISIBLE "Start new build" card is rendered INLINE by the run-block.
  // ONLY a 404 sets this — transient network/500 stays silent (no false "session gone" claim).
  const [sessionGone, setSessionGone] = useState(false)
  const status = activeView.status

  // The agent-written code (SessionState.code.files) AND the structured test evidence
  // (SessionState.testEvidence — PR #75) both live on the EXISTING GET /sessions/:id; no
  // events carry the file contents or the per-scenario detail. Re-fetch via the existing
  // client when the run progresses so the Code tab shows the real artifact and the Trust
  // tab shows the auditable evidence behind the verified result. Targets the ACTIVE run.
  const [codeFiles, setCodeFiles] = useState<CodeArtifact['files'] | undefined>(undefined)
  const [testEvidence, setTestEvidence] = useState<TestEvidence | undefined>(undefined)
  // The AUTHORITATIVE backend SessionStatus (richer than the SSE-derived view.status — it carries
  // awaiting_*/verify_failed/push_failed). One reopen RULE (P1-4) reads it: a terminal status is
  // interactive (view + iterate), a non-terminal one is the live cockpit — regardless of door.
  const [backendStatus, setBackendStatus] = useState<SessionStatus | undefined>(undefined)
  // UX honesty (B.5b): when this build EDITS a prior app (session.base set server-side), say
  // so visibly — the user must never be surprised that agents merged over existing files.
  const [editsBase, setEditsBase] = useState(false)
  // The LAST persisted publish outcome (session.publish) — fed to PublishButton so a just-deployed
  // live URL / honest failure survives a tab-switch or refresh.
  const [publishRecord, setPublishRecord] = useState<PublishRecord | undefined>(undefined)

  /** Keep the address bar's ?s= deep-link pointing at the ACTIVE session (refresh-safe). */
  const syncUrl = (id: string): void => {
    if (typeof window !== 'undefined') window.history.replaceState({}, '', `${window.location.pathname}?s=${id}`)
  }

  /** Seed the spine with a clean greeting + a SINGLE run marker, then remount AkisChat so it loads
   *  it. Used by BOTH History doors (HistoryMenu + the /?s= deep-link): a reopened build shows a
   *  CLEAN chat (never an unrelated inherited conversation) plus its one run-block, which replays
   *  the server /log to rebuild the transcript. */
  const seedRun = (id: string, idea: string): void => {
    const nodes: ThreadNode[] = [{ role: 'assistant', content: t('akis.greeting') }, { role: 'run', sessionId: id, idea: idea.trim() }]
    saveThread(nodes)
    setThreadKey(k => k + 1)
    setActiveSessionId(id); setActiveIdea(idea); setActiveView(emptyView(id))
    setBackendStatus(undefined); setActionError(undefined); setStartingSpec(undefined); setSessionGone(false)
  }

  // Prefer server-backed per-user history (persists across devices); fall back to the
  // localStorage list (loaded above) if the request fails.
  useEffect(() => {
    void api.listMySessions().then(list => {
      if (list.length) setRecent(list.map(s => ({ id: s.id, idea: s.idea, ts: 0, status: s.status, verified: s.verified })))
      // Resolve the /?s= deep-link: seed a one-run thread for that build (status-driven mode,
      // not door-driven). The run-block replays /log to rebuild the transcript.
      const id = deepLinkId.current
      if (id) {
        deepLinkId.current = undefined
        const hit = list.find(s => s.id === id)
        seedRun(id, hit?.idea ?? '')
      }
    }).catch(() => {
      // Even if the list fails, still honor a deep-link by id (replay rebuilds the transcript).
      const id = deepLinkId.current
      if (id) { deepLinkId.current = undefined; seedRun(id, '') }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api])

  // Snapshot effect — targets the ACTIVE run for codeFiles/editsBase/backendStatus/publish + the
  // honest 404 → sessionGone (which drives the right rail; the visible card is inside the run-block).
  useEffect(() => {
    if (!activeSessionId) { setCodeFiles(undefined); setTestEvidence(undefined); setEditsBase(false); setSessionGone(false); setBackendStatus(undefined); setPublishRecord(undefined); return }
    let cancelled = false
    void api.getSession(activeSessionId)
      .then(s => { if (!cancelled) { setCodeFiles(s.code?.files); setTestEvidence(s.testEvidence); setEditsBase(!!s.base); setBackendStatus(s.status); setPublishRecord(s.publish); setSessionGone(false) } })
      .catch(e => {
        if (cancelled) return
        // A 404 means the session is genuinely GONE → honest recovery. Any OTHER error (network,
        // 500) keeps today's silent behavior: rail stays empty, no false "gone" claim.
        if (ApiError.is(e) && e.status === 404) setSessionGone(true)
      })
    return () => { cancelled = true }
    // activeView.connectionGone in the deps (Opus review M1): the LIVE frozen-tab case — a silent
    // server restart emits no status change, so the 404 probe must re-run when the stream gives up.
  }, [activeSessionId, status, api, activeView.connectionGone])

  // The single build path: the chat-authored spec becomes a session via the UNCHANGED startSession
  // → the same 4 structural gates + pipeline + History. The ONLY caller is the Chat-to-Build
  // approval (AkisChat's SpecCard "Approve & Build"). startBuild RETURNS the new session id so
  // AkisChat can append the inline run marker at its slot; it sets the ACTIVE run here.
  const startBuild = async (v: string): Promise<string | undefined> => {
    const idea = v.trim(); if (!idea || busy || startingRef.current) return undefined
    startingRef.current = true
    setBusy(true); setActionError(undefined); setStartingSpec(idea)
    try {
      // If a PRIOR build is still IN-FLIGHT, approving a new spec ABANDONS it (mirrors newChat):
      // cancel it server-side so the now-non-active older block (which folds its /log ONCE and
      // closes its stream) isn't left running headless behind a frozen UI. Gate-SAFE: cancel only
      // sets 'cancelled', never mints. A terminal prior run 409s the cancel (caught) — a no-op.
      if (activeSessionId && !isTerminalStatus(backendStatus)) {
        void api.cancelRun(activeSessionId).catch(() => { /* already terminal / transient — nothing to stop */ })
      }
      // Follow-up CHANGES edit the prior (ACTIVE) app (Phase B.5): when it PRODUCED CODE, the next
      // approved spec EDITS that app (baseSessionId → agents merge over its files). The condition
      // mirrors the backend's code-presence guard via the already-fetched codeFiles. The base is the
      // ACTIVE session + its code files (preserved across the multi-run change).
      const baseId = activeSessionId && codeFiles?.length ? activeSessionId : undefined
      // P0-1: the chat-approved spec is AUTHORITATIVE — `idea` IS the spec the SpecCard rendered +
      // the human approved. Pass it as the spec seed so the backend auto-satisfies Gate 1 (still
      // minted server-side via the approvalAuthority) and FIRE-AND-FORGET kicks the run (the seeded-
      // start auto-kick) — NO second approve, NO client api.run. Multi-run = separate startSession
      // calls, each one session + one kick.
      const s = await api.startSession(idea, undefined, baseId, specSeedFromMarkdown(idea))
      // The NEW build becomes the active run. codeFiles reset to the new session's snapshot effect;
      // editsBase reflects the new session (the snapshot effect re-reads it).
      setActiveSessionId(s.id); setActiveIdea(idea); setActiveView(emptyView(s.id)); setStartingSpec(undefined)
      syncUrl(s.id)
      setRecent(recordRecentBuild({ id: s.id, idea, ts: Date.now() }))
      return s.id
    } catch (e) { setActionError(ApiError.is(e) ? `${e.code ?? 'error'}: ${e.message}` : String(e)); setStartingSpec(undefined); return undefined }
    finally { setBusy(false); startingRef.current = false }
  }

  /** Re-open a past build (BOTH History doors route here). Seeds a one-run thread + clean greeting;
   *  the run-block replays /log + /events. */
  const openSession = (b: RecentBuild): void => { seedRun(b.id, b.idea) }

  // Stable across renders, so the gate callbacks keep a stable identity.
  const act = useCallback(async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true); setActionError(undefined)
    try { await fn() } catch (e) { setActionError(ApiError.is(e) ? `${e.code ?? 'error'}: ${e.message}` : String(e)) } finally { setBusy(false) }
  }, [])
  // Gate callbacks target the ACTIVE run (only the active run ever shows an awaiting gate). A
  // seeded chat build auto-satisfies the spec gate server-side, so approve is the LEGACY non-seeded
  // path (kept for compat); it never mints client-side. Fire-and-forget the /run so a slow pipeline
  // never greys out every control.
  const approve = useCallback((): Promise<void> => act(async () => {
    if (!activeSessionId) return
    await api.approve(activeSessionId)
    void api.run(activeSessionId).catch(e => setActionError(ApiError.is(e) ? `${e.code ?? 'error'}: ${e.message}` : String(e)))
  }), [act, api, activeSessionId])
  const confirm = useCallback((): Promise<void> => act(async () => { if (activeSessionId) await api.confirm(activeSessionId) }), [act, api, activeSessionId])
  // Localized note for a failed/unsupported preview boot (carries the backend's short reason).
  const previewFailNote = (e: { status: 'starting' | 'ready' | 'failed' | 'stopped' | 'unsupported'; reason?: string }): string =>
    t(e.status === 'unsupported' ? 'preview.unsupported' : 'preview.failed') + (e.reason ? `: ${e.reason}` : '')
  const runApp = (): Promise<void> => act(async () => {
    if (!activeSessionId) return
    const e = await api.startPreview(activeSessionId)
    if (e.status === 'failed' || e.status === 'unsupported') setActionError(previewFailNote(e))
  })
  const newChat = (): void => {
    // P1-6: 'New build' on a NON-TERMINAL active run must STOP it, not orphan it. Cancel the backend
    // pipeline (api.cancel → Orchestrator.cancel; only sets 'cancelled', NEVER mints) BEFORE clearing.
    if (activeSessionId && !isTerminalStatus(backendStatus)) {
      void api.cancelRun(activeSessionId).catch(() => { /* already terminal / transient — nothing to stop */ })
    }
    setSessionGone(false)
    setActiveSessionId(undefined); setActiveIdea(''); setActiveView(emptyView('')); setActionError(undefined); setStartingSpec(undefined); setBackendStatus(undefined)
    // Drop the persisted spine + remount AkisChat so it re-seeds a clean greeting (no run markers).
    clearThread(); setThreadKey(k => k + 1)
    if (typeof window !== 'undefined' && window.location.search) window.history.replaceState({}, '', window.location.pathname)
  }

  // Auto-run the local preview once a build ships, so the app appears live with no extra click.
  const autoRan = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (activeSessionId && status === 'done' && autoRan.current !== activeSessionId) {
      autoRan.current = activeSessionId
      void api.startPreview(activeSessionId)
        .then(e => { if (e.status === 'failed' || e.status === 'unsupported') setActionError(previewFailNote(e)) })
        .catch(() => { /* network reject — surfaced via preview_status / manual run */ })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, status, api])

  const canRun = !!activeSessionId && (status === 'done' || activeView.verified !== undefined)
  // BUILD-AWARE CHAT context key: the ACTIVE session id ONLY when it produced code (so the persona
  // can answer about — and route edits to — the current app). SEPARATE from chat-only overrides;
  // never reaches a build. No code yet ⇒ stateless chat (byte-identical request).
  const buildContextSessionId = activeSessionId && codeFiles?.length ? activeSessionId : undefined

  const startingWorkflowCard = startingSpec ? (
    <section role="status" className="rounded-2xl border border-teal-400/25 bg-teal-400/[0.06] p-3 text-sm text-slate-200 shadow-[0_0_30px_rgba(7,209,175,0.1)]">
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

  // Edit-mode disclosure (B.5b): the ACTIVE build merges over a prior app — surfaced once, here,
  // above the chat (the inline run-block stays focused on its pipeline + bubbles).
  const editsBaseBadge = editsBase ? (
    <div className="inline-flex w-fit items-center gap-1.5 rounded-md border border-violet-400/30 bg-violet-400/[0.08] px-2 py-0.5 text-[11px] font-medium text-violet-200">
      <span aria-hidden>🔁</span> {t('pipeline.editsBase')}
    </div>
  ) : null

  // Shared frame header: the live agent roster (active run) + history (+ New chat once a run exists).
  const header = (
    <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-2">
      <AgentRoster view={activeView} />
      <div className="flex shrink-0 items-center gap-2">
        <HistoryMenu builds={recent} onOpen={openSession} />
        {activeSessionId && <button onClick={newChat} className="shrink-0 rounded border border-white/10 px-2 py-0.5 text-xs text-slate-400 hover:text-slate-200">{t('chat.new')}</button>}
      </div>
    </div>
  )

  // The single conversation surface — the chat spine with inline run-blocks. Shared between idle and
  // build layouts so there is ONE render + ONE scroll. AkisChat appends run markers in place and
  // renders each as a RunBlock; only the active run stays live.
  const chat = (
    <AkisChat
      key={threadKey}
      api={api}
      baseUrl={baseUrl}
      {...(makeClient ? { makeClient } : {})}
      building={busy}
      onBuild={startBuild}
      {...(activeSessionId ? { activeSessionId } : {})}
      {...(buildContextSessionId ? { buildContextSessionId } : {})}
      onApprove={approve}
      onConfirm={confirm}
      onNewBuild={newChat}
      onActiveView={setActiveView}
      starting={startingWorkflowCard}
    />
  )

  // Height-bounded so the chat scrolls INSIDE the frame instead of growing the page (stable, no
  // jump). The conversation stays the primary surface; preview lives in the rail once a run exists.
  // STABLE TREE: the chat <section> sits at the SAME tree position whether idle or building, so
  // approving a spec (idle → build) never REMOUNTS AkisChat (which would discard the just-appended
  // inline run marker). Only the rail is conditionally added as a sibling.
  const hasRun = !!activeSessionId
  return (
    <div className="flex min-h-[32rem] flex-col lg:h-[calc(100dvh-8.5rem)]">
      <div className={`grid min-h-0 flex-1 gap-6 ${hasRun ? (previewOpen ? 'lg:grid-cols-[minmax(0,1fr)_minmax(30rem,42%)] xl:grid-cols-[minmax(0,1fr)_minmax(34rem,46%)]' : 'lg:grid-cols-[minmax(0,1fr)_4rem]') : 'grid-cols-1'}`}>
        <section className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02] shadow-[0_0_60px_rgba(124,58,237,0.06)] backdrop-blur-sm">
          {header}
          <div className={`mx-auto flex min-h-0 w-full flex-1 flex-col gap-3 px-4 py-4 ${hasRun ? 'max-w-4xl xl:max-w-5xl' : 'max-w-3xl xl:max-w-4xl'}`}>
            {actionError && <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{actionError}</div>}
            {editsBaseBadge}
            <div className="min-h-0 flex-1">{chat}</div>
          </div>
        </section>

        {/* Live preview rail — the actually-running app (the ACTIVE run). Only once a run exists. */}
        {hasRun && (
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
                {activeSessionId && !sessionGone && status === 'done' && <TrustReportCard sessionId={activeSessionId} api={api} />}
                {/* Publish to your OWN server (OCI) — POST-`done`, optional, NON-GATING. */}
                {activeSessionId && !sessionGone && status === 'done' && <PublishButton sessionId={activeSessionId} api={api} initialRecord={publishRecord} />}
                <PreviewPanel view={activeView} onRun={() => void runApp()} busy={busy} canRun={canRun} files={codeFiles} testEvidence={testEvidence} actionError={actionError} />
              </>
            ) : (
              <button
                type="button"
                onClick={() => setPreviewOpen(true)}
                className="flex min-h-28 w-full flex-col items-center justify-center gap-2 rounded-xl border border-white/10 bg-black/30 px-2 text-center text-xs text-slate-300 hover:border-teal-400/30 hover:text-teal-200"
              >
                <span aria-hidden>▣</span>
                <span>{t('preview.collapsed')}</span>
                {activeView.verified !== undefined && (
                  <span className={activeView.verified ? 'text-emerald-300' : 'text-slate-400'}>
                    {activeView.verified ? t('preview.verified') : t('preview.unverified')}
                  </span>
                )}
              </button>
            )}
          </aside>
        )}
      </div>
    </div>
  )
}
