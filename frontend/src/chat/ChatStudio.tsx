import { useState, useEffect, useRef } from 'react'
import { ApiClient, ApiError } from '../api/client.js'
import { useI18n } from '../i18n/I18nContext.js'
import { useLiveChat } from './useLiveChat.js'
import { ChatThread } from './ChatThread.js'
import { RunPipeline } from './RunPipeline.js'
import { AkisChat } from './AkisChat.js'
import { AkisTranscript } from './AkisTranscript.js'
import { loadThread, clearThread, type AkisMsg } from './akisThread.js'
import { loadRecentBuilds, recordRecentBuild, type RecentBuild } from './recentBuilds.js'
import { HistoryMenu } from './HistoryMenu.js'
import { sessionIdFromSearch } from './sessionParam.js'
import { PreviewPanel } from '../components/PreviewPanel.js'
import { AgentRoster } from '../components/AgentRoster.js'
import type { EventStreamClient } from '../live/EventStreamClient.js'
import type { CodeArtifact, TestEvidence } from '@akis/shared'

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
export function ChatStudio({ api, baseUrl = '', makeClient }: { api: ApiClient; baseUrl?: string; makeClient?: () => EventStreamClient }) {
  const { t } = useI18n()
  const [sent, setSent] = useState('')               // the submitted idea (drives the thread)
  const [sessionId, setSessionId] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [recent, setRecent] = useState<RecentBuild[]>(() => loadRecentBuilds())
  // Deep-link target from /?s=<id> (History page → open in Studio). Read once on mount.
  const deepLinkId = useRef<string | undefined>(typeof window !== 'undefined' ? sessionIdFromSearch(window.location.search) : undefined)
  // Prefer server-backed per-user history (persists across devices); fall back to the
  // localStorage list (loaded above) if the request fails.
  useEffect(() => {
    void api.listMySessions().then(list => {
      if (list.length) setRecent(list.map(s => ({ id: s.id, idea: s.idea, ts: 0 })))
      // Resolve the /?s= deep-link: open that build (with its idea, for the user bubble).
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
  // The persisted "Ask AKIS" conversation that produced the build. AkisChat owns it while
  // chatting (and persists it to localStorage); we snapshot it when a build starts so the
  // transcript can show it above the pipeline even after the chat unmounts / a reload.
  const [thread, setThread] = useState<AkisMsg[]>([])
  // The persisted thread is the CURRENT live conversation, so it belongs to a build STARTED
  // from this chat (or its reload), NOT to an OLD build re-opened from History — showing it
  // there would be a stale, unrelated transcript. `reopened` gates that out.
  const [reopened, setReopened] = useState(false)
  useEffect(() => { if (sessionId) setThread(loadThread()) }, [sessionId])

  const live = useLiveChat(sessionId, sent, api, baseUrl, makeClient)
  const status = live.view.status

  // The agent-written code (SessionState.code.files) AND the structured test evidence
  // (SessionState.testEvidence — PR #75) both live on the EXISTING GET /sessions/:id; no
  // events carry the file contents or the per-scenario detail. Re-fetch via the existing
  // client when the run progresses so the Code tab shows the real artifact and the Trust
  // tab shows the auditable evidence behind the verified result.
  const [codeFiles, setCodeFiles] = useState<CodeArtifact['files'] | undefined>(undefined)
  const [testEvidence, setTestEvidence] = useState<TestEvidence | undefined>(undefined)
  useEffect(() => {
    if (!sessionId) { setCodeFiles(undefined); setTestEvidence(undefined); return }
    let cancelled = false
    void api.getSession(sessionId)
      .then(s => { if (!cancelled) { setCodeFiles(s.code?.files); setTestEvidence(s.testEvidence) } })
      .catch(() => { /* Code/Trust tabs simply stay empty; surfaced nowhere else */ })
    return () => { cancelled = true }
  }, [sessionId, status, api])

  // The single build path: the chat-authored spec becomes a session via the UNCHANGED
  // startSession → the same 4 structural gates + pipeline + History. The ONLY caller is the
  // Chat-to-Build approval (the SpecCard's "Approve & Build"), so every build flows through
  // the conversation — there is no other entry point.
  const startBuild = async (v: string): Promise<void> => {
    const idea = v.trim(); if (!idea || busy) return
    setBusy(true); setActionError(undefined)
    try {
      const s = await api.startSession(idea)
      setSent(idea); setSessionId(s.id); setReopened(false)
      setRecent(recordRecentBuild({ id: s.id, idea, ts: Date.now() }))
    } catch (e) { setActionError(ApiError.is(e) ? `${e.code ?? 'error'}: ${e.message}` : String(e)) }
    finally { setBusy(false) }
  }
  /** Re-open a past build — useLiveChat replays /log + /events to rebuild the thread. */
  const openSession = (b: RecentBuild): void => { setActionError(undefined); setSent(b.idea); setSessionId(b.id); setReopened(true) }
  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true); setActionError(undefined)
    try { await fn() } catch (e) { setActionError(ApiError.is(e) ? `${e.code ?? 'error'}: ${e.message}` : String(e)) } finally { setBusy(false) }
  }
  const approve = (): Promise<void> => act(async () => { if (sessionId) { await api.approve(sessionId); await api.run(sessionId) } })
  const confirm = (): Promise<void> => act(async () => { if (sessionId) await api.confirm(sessionId) })
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
    setSessionId(undefined); setSent(''); setActionError(undefined)
    // Start a fresh conversation: drop the persisted thread so AkisChat re-seeds the greeting.
    clearThread(); setThread([]); setReopened(false)
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
  // screens where the header wraps. A single full-width conversation is the entry point;
  // once a run starts, it splits into the pipeline + the live-preview rail.
  return (
    <div className="flex min-h-[32rem] flex-col lg:h-[calc(100dvh-8.5rem)]">
      {sessionId ? (
        <div className="grid min-h-0 flex-1 gap-6 lg:grid-cols-[1fr_24rem]">
          {/* Run pipeline (each agent's stage, live) */}
          <section className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02] shadow-[0_0_60px_rgba(124,58,237,0.06)] backdrop-blur-sm">
            {header}
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              {!reopened && <AkisTranscript messages={thread} />}
              <RunPipeline
                view={live.view}
                onApprove={approve}
                onConfirm={confirm}
                busy={busy}
                api={api}
                details={<ChatThread messages={live.messages} onApprove={approve} onConfirm={confirm} busy={busy} />}
              />
              {actionError && <div role="alert" className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{actionError}</div>}
            </div>
          </section>

          {/* Live preview rail — the actually-running app */}
          <aside className="min-h-0 overflow-y-auto rounded-2xl border border-white/10 bg-white/[0.02] p-4 backdrop-blur-sm">
            <PreviewPanel view={live.view} onRun={() => void runApp()} busy={busy} canRun={canRun} files={codeFiles} testEvidence={testEvidence} actionError={actionError} />
          </aside>
        </div>
      ) : (
        // Idle: one full-height conversation, centered for readability. AkisChat owns the
        // input (pinned at the bottom) and scrolls internally; approving the spec card it
        // produces is the only way to start a build.
        <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02] shadow-[0_0_60px_rgba(124,58,237,0.06)] backdrop-blur-sm">
          {header}
          <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-3 px-4 py-4">
            {actionError && <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{actionError}</div>}
            <div className="min-h-0 flex-1">
              <AkisChat api={api} onBuild={(spec) => void startBuild(spec)} />
            </div>
          </div>
        </section>
      )}
    </div>
  )
}
