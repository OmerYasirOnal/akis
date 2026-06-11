import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react'
import type { StringKey } from '../i18n/catalog.js'
import { ApiClient, ApiError } from '../api/client.js'
import { useI18n } from '../i18n/I18nContext.js'
import { specSeedFromMarkdown } from './buildSpec.js'
import { actionErrorText } from './actionError.js'
import { AkisChat } from './AkisChat.js'
import { clearThread, saveThread, loadThread, mergeSpine, historyForApi, type ThreadNode } from './akisThread.js'
import { loadRecentBuilds, recordRecentBuild, RECENT_MAX, type RecentBuild } from './recentBuilds.js'
import { HistoryMenu } from './HistoryMenu.js'
import { sessionIdFromSearch } from './sessionParam.js'
import { useResizable, clampRatio } from './useResizable.js'
import { PreviewPanel } from '../components/PreviewPanel.js'
import { PreviewDrawer } from '../components/PreviewDrawer.js'
import type { Device } from '../components/DeviceFrame.js'
import { TrustReportCard } from '../components/TrustReportCard.js'
import { PublishButton } from '../components/PublishButton.js'
import { ExternalWriteCard } from '../components/ExternalWriteCard.js'
import { AgentWriteProposals } from '../components/AgentWriteProposals.js'
import { AgentRoster } from '../components/AgentRoster.js'
import { Link } from '../router/router.js'
import { emptyView } from '../live/viewModel.js'
import type { EventStreamClient } from '../live/EventStreamClient.js'
import type { SessionView } from '../live/types.js'
import type { CodeArtifact, TestEvidence, SessionStatus, PublishRecord, SessionState } from '@akis/shared'

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
  // Device preset for the preview iframe (Responsive default · Mobil 390 · Masaüstü min(1280,pane)).
  // Lifted to the studio so it persists across tab flips; threaded into PreviewPanel → DeviceFrame,
  // which sets the iframe's LOGICAL width only (no sandbox/src change).
  const [device, setDevice] = useState<Device>('responsive')
  // The studio SHELL width — measured read-only via a ResizeObserver — feeds useResizable so the
  // drawer ratio clamps against the real container (the 28rem chat floor + 60% cap are width-relative,
  // not viewport-relative). One setState per resize (no per-frame storm). The drawer itself is an
  // ABSOLUTE sibling out of the flex flow, so this measures the chat column's available width.
  const shellRef = useRef<HTMLDivElement | null>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  // LOW-2 (no first-frame flash): on a reload where the persisted drawer is OPEN, `containerWidth`
  // starts 0, so `previewW` resolves to '0px' and the drawer would paint at width:0 for the one frame
  // before the ResizeObserver fires post-paint — a visible flash of a collapsed drawer. Measure the
  // shell SYNCHRONOUSLY before paint here and seed `containerWidth` so `--preview-w` is already correct
  // on the first frame. Guarded to only seed while still 0 (and only when the rect has real width) so
  // it never fights the ResizeObserver below, which owns every subsequent resize. useLayoutEffect runs
  // before the browser paints; useEffect would run after, defeating the purpose.
  useLayoutEffect(() => {
    const el = shellRef.current
    if (!el) return
    const w = el.getBoundingClientRect().width
    if (w > 0) setContainerWidth(prev => (prev === 0 ? w : prev))
  }, [])
  useEffect(() => {
    const el = shellRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width
      if (typeof w === 'number') setContainerWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // The drawer's open/width state lives in useResizable (persisted ratio + open in localStorage,
  // re-clamped vs the current container). open/ratio drive the push-split; the keyboard splitter +
  // pointer drag are wired below. Pure view-state — no gate authority.
  const { open: previewOpen, ratio, openDrawer, closeDrawer, commitRatio, resetRatio, onKeyDown: onResizeKeyDown } = useResizable({ containerWidth })
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

  /** Seed the spine with a clean greeting + a SINGLE run marker (+ the build's PERSISTED
   *  conversation when given), then remount AkisChat so it loads it. Used by BOTH History doors
   *  (HistoryMenu + the /?s= deep-link): a reopened build shows ITS OWN conversation (rehydrated
   *  from session.chat — the F5 fix: localStorage alone got clobbered by exactly this seed) plus
   *  its one run-block, which replays the server /log to rebuild the transcript. The run marker
   *  sits right after the greeting; the restored turns follow it (the common case — questions
   *  asked about a build — reads chronologically under its run-block). */
  const seedRun = (id: string, idea: string, chat?: SessionState['chat']): void => {
    // Reopening a build REPLACES the spine, so an in-flight active run would be orphaned (its
    // run-block unmounts; it keeps running headless server-side). Cancel it first — mirrors newChat /
    // startBuild. Skip when reopening the SAME id, and on a terminal run (409s, caught = no-op).
    if (activeSessionId && activeSessionId !== id && !isTerminalStatus(backendStatus)) {
      void api.cancelRun(activeSessionId).catch(() => { /* already terminal / transient */ })
    }
    // MERGE — never overwrite. The local spine, when it already anchors THIS run (has its run
    // marker), is the richest copy: it holds the pre-build, sessionId-less turns the server can
    // never store (typed before the build existed) AND is re-saved on every same-device turn, so
    // it is authoritative. mergeSpine keeps it in that case; otherwise (cleared storage / another
    // device) it rebuilds from the server turns. Either way the conversation is not lost on return.
    const restoredTurns = (chat ?? [])
      .filter(turn => turn.content.trim().length > 0)
      .map(turn => ({ role: turn.role, content: turn.content }))
    const nodes: ThreadNode[] = mergeSpine({ local: loadThread(), serverTurns: restoredTurns, id, greeting: t('akis.greeting'), idea })
    saveThread(nodes)
    setThreadKey(k => k + 1)
    // #35: a REOPEN must NOT auto-(re)boot the local preview — the user may only want to read the
    // transcript, and spawning a process per reopen is wasteful. Pre-seed autoRan with the reopened
    // id so the auto-preview effect skips it; a FRESH build / a LIVE completion still auto-previews
    // (autoRan was never set to that id). Manual "Run app" still boots a reopened build on demand.
    autoRan.current = id
    // #35 (M5): pre-seed the drawer auto-open guard too, so a reopened build's preview becoming
    // 'ready' (manual Run, or a replayed ready frame) does NOT slide the drawer open unbidden.
    drawerAutoOpened.current = id
    setActiveSessionId(id); setActiveIdea(idea); setActiveView(emptyView(id))
    setBackendStatus(undefined); setActionError(undefined); setStartingSpec(undefined); setSessionGone(false)
    // Point the address bar at the reopened build so a refresh reloads THIS session, not the
    // previously-deep-linked one (the in-studio HistoryMenu reopen used to leave ?s= stale → F5
    // reopened the wrong/none session). Also clears any previous run's snapshot bleed below.
    syncUrl(id)
    setCodeFiles(undefined); setTestEvidence(undefined); setEditsBase(false); setPublishRecord(undefined)
  }

  /** Open a session WITH its persisted conversation: fetch session.chat first (the F5 rehydrate),
   *  fall back to a bare seed when the read fails (network/404 — the run-block surfaces those). */
  const openWithChat = (id: string, fallbackIdea: string): void => {
    void api.getSession(id)
      .then(s => seedRun(id, s.idea || fallbackIdea, s.chat))
      .catch(() => seedRun(id, fallbackIdea))
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
        openWithChat(id, hit?.idea ?? '')
      }
    }).catch(() => {
      // Even if the list fails, still honor a deep-link by id (replay rebuilds the transcript).
      const id = deepLinkId.current
      if (id) { deepLinkId.current = undefined; openWithChat(id, '') }
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
  // useCallback-STABLE so AkisChat's onBuild identity holds across the active run's per-frame
  // setActiveView re-renders (the memoized RunBlock siblings then bail). Reactive deps only;
  // syncUrl is a pure inner fn (no reactive closure).
  const startBuild = useCallback(async (v: string): Promise<string | undefined> => {
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
      // Send the PRE-BUILD conversation (the spec-shaping user/assistant turns typed before this
      // build existed — historyForApi skips the greeting, run markers AND error rows). The server
      // seeds them ATOMICALLY onto session.chat (a NON-gate column) so a CROSS-DEVICE reopen
      // rehydrates them too; same-device reopen is already covered by the local-spine merge in seedRun.
      const preBuildChat = historyForApi(loadThread(), t('akis.greeting'))
      const s = await api.startSession(idea, undefined, baseId, specSeedFromMarkdown(idea), preBuildChat)
      // The NEW build becomes the active run. codeFiles reset to the new session's snapshot effect;
      // editsBase reflects the new session (the snapshot effect re-reads it).
      setActiveSessionId(s.id); setActiveIdea(idea); setActiveView(emptyView(s.id)); setStartingSpec(undefined)
      // SYNCHRONOUS reset of the PRIOR run's snapshot-derived state (mirrors seedRun) — the new
      // active run's snapshot effect repopulates from getSession(s.id). Without this, the prior run's
      // backendStatus/codeFiles linger until that async fetch lands, and in that window a rapid 2nd
      // approval (a) reads a stale terminal backendStatus and so does NOT cancel this in-flight run
      // (orphaned, token-burning), and (b) base-merges onto the wrong run; the rail also bleeds the
      // prior result onto this fresh build. Clearing here closes the cross-run race.
      setBackendStatus(undefined); setCodeFiles(undefined); setTestEvidence(undefined); setEditsBase(false); setPublishRecord(undefined)
      syncUrl(s.id)
      setRecent(prev => [{ id: s.id, idea, ts: Date.now() }, ...prev.filter(b => b.id !== s.id)].slice(0, RECENT_MAX))
      recordRecentBuild({ id: s.id, idea, ts: Date.now() }) // persist to localStorage (return ignored — we merge into live state above)
      return s.id
    } catch (e) { setActionError(actionErrorText(e, t)); setStartingSpec(undefined); return undefined }
    finally { setBusy(false); startingRef.current = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, activeSessionId, backendStatus, codeFiles, api, t])

  /** Re-open a past build (BOTH History doors route here). Seeds a one-run thread + clean greeting;
   *  the run-block replays /log + /events. useCallback-stable so HistoryMenu's onOpen + the studio's
   *  onNewBuild path don't churn the spine; openWithChat/seedRun are pure inner fns over the reactive
   *  deps listed (their captured state is mirrored here). */
  const openSession = useCallback((b: RecentBuild): void => { openWithChat(b.id, b.idea) },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, activeSessionId, backendStatus, t])

  // Stable across renders, so the gate callbacks keep a stable identity.
  const act = useCallback(async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true); setActionError(undefined)
    try { await fn() } catch (e) { setActionError(actionErrorText(e, t)) } finally { setBusy(false) }
  }, [t])
  // Gate callbacks target the ACTIVE run (only the active run ever shows an awaiting gate). A
  // seeded chat build auto-satisfies the spec gate server-side, so approve is the LEGACY non-seeded
  // path (kept for compat); it never mints client-side. Fire-and-forget the /run so a slow pipeline
  // never greys out every control.
  const approve = useCallback((): Promise<void> => act(async () => {
    if (!activeSessionId) return
    await api.approve(activeSessionId)
    void api.run(activeSessionId).catch(e => setActionError(actionErrorText(e, t)))
  }), [act, api, activeSessionId, t])
  const confirm = useCallback((): Promise<void> => act(async () => { if (activeSessionId) await api.confirm(activeSessionId) }), [act, api, activeSessionId])
  // Re-activate an OLDER run (a recovery/gate action fired on a non-active, one-shot-folded block):
  // make it the live active run so its result streams in. Resets the snapshot-derived state for the
  // switch (the snapshot effect repopulates from getSession). Same reset discipline as startBuild/seedRun.
  const reactivateRun = useCallback((id: string): void => {
    if (id === activeSessionId) return
    setActiveSessionId(id); setActiveView(emptyView(id)); setActionError(undefined)
    setBackendStatus(undefined); setCodeFiles(undefined); setTestEvidence(undefined); setEditsBase(false); setPublishRecord(undefined); setSessionGone(false)
    syncUrl(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId])
  // Localized note for a failed/unsupported preview boot (carries the backend's short reason).
  const previewFailNote = (e: { status: 'starting' | 'ready' | 'failed' | 'stopped' | 'unsupported'; reason?: string }): string =>
    t(e.status === 'unsupported' ? 'preview.unsupported' : 'preview.failed') + (e.reason ? `: ${e.reason}` : '')
  const runApp = useCallback((): Promise<void> => act(async () => {
    if (!activeSessionId) return
    const e = await api.startPreview(activeSessionId)
    if (e.status === 'failed' || e.status === 'unsupported') setActionError(previewFailNote(e))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [act, activeSessionId, api, t])
  const newChat = useCallback((): void => {
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
  }, [activeSessionId, backendStatus, api])

  // Auto-run the local preview once a build ships, so the app appears live with no extra click.
  const autoRan = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (activeSessionId && (status === 'done' || backendStatus === 'done') && autoRan.current !== activeSessionId) {
      autoRan.current = activeSessionId
      void api.startPreview(activeSessionId)
        .then(e => { if (e.status === 'failed' || e.status === 'unsupported') setActionError(previewFailNote(e)) })
        .catch(() => { /* network reject — surfaced via preview_status / manual run */ })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, status, api])

  // #35 (M5) drawer auto-open guard — a SEPARATE ref from autoRan (the preview-boot guard) so the two
  // concerns can't entangle. seedRun pre-seeds this with the reopened id (alongside autoRan) so a
  // REOPEN never auto-opens the drawer (the user may only want the transcript). A FRESH build leaves
  // it unset, so the first 'ready' frame auto-opens once. Closing the drawer keeps the id seeded, so a
  // later 'ready' (a re-run within the same session) won't re-pop it against the user's choice.
  const drawerAutoOpened = useRef<string | undefined>(undefined)
  // AUTO-OPEN ON READY (H2): open the drawer the moment the ACTIVE run's preview is embeddable —
  // `view.preview.ready === true` (a ready frame carries a /preview/:id/ url). NEVER on `starting`
  // (that would slide an empty spinner in and out — the anti-flicker rule). Fires at most once per
  // session via drawerAutoOpened. View-state only; reads the already-folded view (no SSE setState).
  useEffect(() => {
    if (activeSessionId && activeView.preview.ready && drawerAutoOpened.current !== activeSessionId) {
      drawerAutoOpened.current = activeSessionId
      openDrawer()
    }
  }, [activeSessionId, activeView.preview.ready, openDrawer])

  // AUTHORITATIVE done-ness: the SSE-derived activeView.status OR the persisted backendStatus
  // (from getSession). EITHER may know first — the live stream flips to 'done' immediately on a
  // fresh build, while a REOPENED build whose replay buffer was LRU-evicted (or wiped by a server
  // restart) arrives with an empty live view (status:'unknown') but backendStatus:'done'. Driving
  // the rail/preview/run off this union (not activeView.status alone) is the fix for the HIGH
  // lifecycle finding: a finished, verified build no longer reads as a blank/broken run-block
  // after a reopen — the trust card, publish button, auto-preview and Run all surface from the
  // durable status. (The inline agent-stage bubbles still come from the live view; only the
  // result-rail is made resilient.)
  const isDone = status === 'done' || backendStatus === 'done'
  const canRun = !!activeSessionId && (isDone || activeView.verified !== undefined)
  // BUILD-AWARE CHAT context key: ALWAYS the active session id. It used to be gated on
  // codeFiles?.length, which made every turn before the code snapshot landed (a reopen/F5 race) —
  // and every turn about a code-less/failed build — STATELESS, so AKIS confidently answered
  // "the build hasn't started" about a build that ran and failed (the live-caught bug). The server
  // snapshot handles a code-less session fine (idea/spec/status/verify lines, files only when
  // present). SEPARATE from chat-only overrides; never reaches a build.
  const buildContextSessionId = activeSessionId || undefined

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
        {/* PROMINENT "new build" (owner 2026-06-10): this is the ONLY door out of an active chat into a
            fresh one (the Stüdyo-nav reset was reverted — it destroyed active chats), so it must read as
            a primary action, not a ghost link: teal accent + semibold, same accessible name. */}
        {activeSessionId && <button onClick={newChat} className="shrink-0 rounded-lg border border-teal-400/40 bg-teal-400/10 px-3 py-1 text-xs font-semibold text-teal-200 transition-colors hover:bg-teal-400/20 hover:text-teal-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#07D1AF]/60">{t('chat.new')}</button>}
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
      buildStarting={!!startingSpec}
      onBuild={startBuild}
      {...(activeSessionId ? { activeSessionId } : {})}
      {...(buildContextSessionId ? { buildContextSessionId } : {})}
      onApprove={approve}
      onConfirm={confirm}
      onNewBuild={newChat}
      onActiveView={setActiveView}
      onReactivate={reactivateRun}
      onActionError={setActionError}
      starting={startingWorkflowCard}
    />
  )

  const hasRun = !!activeSessionId

  // RESIZE GEOMETRY BRIDGE. The drawer is geometry-agnostic — it hands the parent a raw clientX and we
  // map it to a width/ratio (only the parent knows the shell's rect). The drawer is RIGHT-anchored, so
  // its width is `shellRight - clientX`; dividing by the container gives the ratio (then clamped to the
  // 30rem floor / 60% cap / 28rem chat floor). The LIVE drag writes the `--preview-w` px var directly on
  // the shell (one DOM write per rAF, no React commit) so chat padding + drawer width move in lockstep
  // without a re-render storm; the COMMIT (on pointerup) persists the ratio through useResizable.
  const ratioFromClientX = useCallback((clientX: number): number => {
    const rect = shellRef.current?.getBoundingClientRect()
    if (!rect || !rect.width) return ratio
    return clampRatio((rect.right - clientX) / rect.width, rect.width)
  }, [ratio])
  const onPointerWidth = useCallback((clientX: number): void => {
    const el = shellRef.current
    if (!el) return
    // A drag only ever runs while the drawer is OPEN, so both vars carry the same live width during it:
    // `--preview-w` eases the chat padding, `--preview-drawer-w` the drawer's own width — written together
    // so the split tracks the cursor 1:1 (one DOM write per rAF, no React commit). On release the next
    // render restores both committed values (the open branch keeps them equal), so there's no flash.
    const px = `${Math.round(ratioFromClientX(clientX) * (el.getBoundingClientRect().width || containerWidth))}px`
    el.style.setProperty('--preview-w', px)
    el.style.setProperty('--preview-drawer-w', px)
  }, [ratioFromClientX, containerWidth])
  const commitFromClientX = useCallback((clientX: number): void => { commitRatio(ratioFromClientX(clientX)) }, [commitRatio, ratioFromClientX])

  // TWO split vars, DECOUPLED so the drawer can slide its FULL self (✕ included) off-screen when closed:
  //  • `--preview-drawer-w` — the drawer's OWN width. ALWAYS the real ratio*containerWidth (never 0), so a
  //    closed drawer keeps full width and `translateX(100%)` genuinely carries the whole box (header/✕/
  //    body) off-canvas. Without this, a width:0 box translated 100% travels 0px → the ✕ paints at the
  //    right edge with nothing closed (the Issue-1 bug).
  //  • `--preview-w` — the CHAT push-padding only. 0 while closed → the chat reflows to full width; the
  //    real width while open so the centered chat shifts into the remaining space. The drag path keeps
  //    writing THIS var per rAF (it only runs while open, so the drawer width tracks it via the open
  //    branch below; on release the render restores both committed values, no flash).
  const fullPreviewW = containerWidth ? `${Math.round(clampRatio(ratio, containerWidth) * containerWidth)}px` : '0px'
  // Reserve the push-split strip ONLY when the drawer is actually RENDERED — i.e. a real run exists
  // (hasRun). The drawer's open/ratio persist in localStorage, so after a session with the drawer open
  // a FRESH chat (activeSessionId undefined → no drawer mounted) would otherwise still pad the chat
  // right by the full ratio for a drawer that isn't there — shifting the conversation left behind a
  // large empty void (owner 2026-06-10). Gating on hasRun makes the no-run studio reflow full-width and
  // center; the persisted ratio/open keep driving the split untouched for sessions WITH a run.
  const previewW = hasRun && previewOpen ? fullPreviewW : '0px'

  // The MOVED rail content (verbatim props + `!sessionGone && isDone` guards). Now the drawer's region A.
  const cards = (
    <>
      {/* Edit-mode disclosure (honesty): the user judges the MERGED result in the drawer, so the
          "edits a prior app" fact must travel here too — the same badge shown above the chat,
          reused (renders only when editsBase, since editsBaseBadge is null otherwise). */}
      {editsBaseBadge}
      {activeSessionId && !sessionGone && isDone && <TrustReportCard sessionId={activeSessionId} api={api} />}
      {/* Publish to your OWN server (OCI) — POST-`done`, optional, NON-GATING. */}
      {activeSessionId && !sessionGone && isDone && <PublishButton sessionId={activeSessionId} api={api} initialRecord={publishRecord} />}
      {/* Agent-proposed GitHub writes — confirm cards for status:'proposed' writes an agent
          recorded via propose_github_write. NOT gated on isDone: a proposal surfaces LIVE
          during the build (it arrives as a propose_github_write tool_call); the human reads
          the exact bound bytes and confirms. AKIS only proposes — never autonomous. */}
      {activeSessionId && !sessionGone && <AgentWriteProposals sessionId={activeSessionId} api={api} />}
      {/* Publish docs/issue to Jira/Confluence via MCP — propose → human-confirm → execute. */}
      {activeSessionId && !sessionGone && isDone && <ExternalWriteCard sessionId={activeSessionId} idea={activeIdea} files={codeFiles} api={api} />}
    </>
  )

  // Height-bounded so the chat scrolls INSIDE the frame instead of growing the page (stable, no
  // jump). The conversation stays the primary surface; the preview lives in the slide-in drawer once a
  // run exists. STABLE TREE: the chat <section> sits at the SAME tree position whether idle or building,
  // so approving a spec (idle → build) never REMOUNTS AkisChat (which would discard the just-appended
  // inline run marker). The drawer is added as an ABSOLUTE sibling of the chat <section>, never a wrapper.
  return (
    // `relative` so the drawer can be an absolute right-edge sibling (out of the flex flow — it can't
    // collapse the chat height, C5). `--preview-w` cascades to chat padding + drawer width.
    <div
      ref={shellRef}
      data-preview-shell
      style={{ '--preview-w': previewW, '--preview-drawer-w': fullPreviewW } as React.CSSProperties}
      // overflow-x-clip: the drawer is an absolute child anchored right-0 at its REAL width; when closed it
      // is translateX(100%) PAST the shell's right edge. The shell sits inside the page's right padding, so
      // without clipping the off-screen drawer peeks a sliver into that gap AND extends scrollWidth (a stray
      // horizontal scrollbar). Clipping horizontally hides the closed drawer completely; the open drawer
      // (right edge flush at the shell edge) and the edge-tab/separator (within bounds) are unaffected.
      className="relative flex min-h-[32rem] flex-col overflow-x-clip lg:h-[calc(100dvh-8.5rem)]"
    >
      {/* The chat <section> KEEPS its exact tree slot (sacred — AkisChat key={threadKey}). Push-split:
          on lg+ it reflows left by `--preview-w` when the drawer is open (so the centered chat shifts
          into the remaining space); below lg the drawer is a full-screen overlay → NO padding (the
          lg:[padding-right] arbitrary class applies the var only at lg+). */}
      <section
        // PUSH-SPLIT MOTION: the chat reflows its right padding by `--preview-w` as the drawer opens/
        // closes. `motion-safe:` so it snaps INSTANTLY under prefers-reduced-motion (a11y) — it must
        // stay in lockstep with the drawer's own `motion-safe` slide, so both honor the same media query.
        // DRAG GUARD: during a separator drag the parent writes `--preview-w` per rAF; the padding ease
        // would LAG the live cursor, so the shell carries `.is-dragging` for the drag and
        // `[.is-dragging_&]:!transition-none` drops the ease → the split tracks the pointer 1:1. The next
        // render after release restores the committed value with the transition back on (no flash).
        // FOREGROUND SURFACE (Issue 3 — cohesion): the chat was `bg-white/[0.02]` (2% white = effectively
        // invisible) with a diffuse outward violet page-glow, so the conversation melted into the page. Raise
        // it to a clear elevated container — `bg-slate-900/60` + `border-white/12` + `backdrop-blur-md` + a
        // CONTAINED inset top-light over a drop shadow (no outward bleed) — so the "place you talk" reads as a
        // distinct foreground surface against the page and the rendered-app white that sits to its right.
        // PADDING GATE: apply the push-split right-padding ONLY when a drawer is actually rendered for a
        // run (hasRun) AND open — matching the `--preview-w` var's own hasRun gate above. A persisted
        // open:true with no run leaves the chat at full width (no padding class, no zero-width ease firing).
        className={`flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-white/12 bg-slate-900/60 shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_8px_40px_rgba(0,0,0,0.45)] backdrop-blur-md motion-safe:transition-[padding] motion-safe:duration-300 motion-safe:ease-out [.is-dragging_&]:!transition-none ${hasRun && previewOpen ? 'lg:[padding-right:var(--preview-w)]' : ''}`}
      >
        {header}
        <div className={`mx-auto flex min-h-0 w-full flex-1 flex-col gap-3 px-4 py-4 ${hasRun ? 'max-w-4xl xl:max-w-5xl 2xl:max-w-6xl' : 'max-w-3xl xl:max-w-4xl 2xl:max-w-5xl'}`}>
          {actionError && (
            <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
              <span>{actionError}</span>
              {/* CTA: a push refused for NO connected GitHub destination (recovery.push.notConnected)
                  gets a direct Settings → GitHub link so the user can connect + retry, instead of a
                  dead-end error. Detected by exact match on the localized string (its sole producer). */}
              {actionError === t('recovery.push.notConnected') && (
                <Link to="/settings" className="shrink-0 rounded border border-rose-300/40 px-2 py-0.5 font-semibold text-rose-100 hover:bg-rose-400/15">
                  {t('recovery.push.connectCta')}
                </Link>
              )}
            </div>
          )}
          {editsBaseBadge}
          <div className="min-h-0 flex-1">{chat}</div>
        </div>
      </section>

      {/* Live preview DRAWER — the actually-running app (the ACTIVE run) + the trust/publish/proposal
          cards. An absolute right-edge sibling of the chat (never a wrapper). Only once a run exists.
          allowAutoOpen=false (M1): a persisted open:true must NOT auto-show the mobile overlay on load
          (FAB controls it). The keyboard splitter + the pointer-drag geometry bridge are wired in. */}
      {hasRun && (
        <PreviewDrawer
          open={previewOpen}
          ratio={ratio}
          onKeyDown={onResizeKeyDown}
          onReset={resetRatio}
          onPointerWidth={onPointerWidth}
          commitRatio={commitFromClientX}
          onOpen={openDrawer}
          onClose={closeDrawer}
          allowAutoOpen={false}
          {...(activeView.verified !== undefined ? { verified: activeView.verified } : {})}
          cards={cards}
          preview={
            <PreviewPanel view={activeView} device={device} onDevice={setDevice} onRun={() => void runApp()} busy={busy} canRun={canRun} files={codeFiles} testEvidence={testEvidence} actionError={actionError} />
          }
        />
      )}
    </div>
  )
}
