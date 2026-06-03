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
import type { WorkflowOption } from '../live/types.js'
import type { EventStreamClient } from '../live/EventStreamClient.js'
import type { CodeArtifact, TestEvidence } from '@akis/shared'

/**
 * The AKIS chat studio: a conversational thread (left) where you talk to AKIS and watch
 * its agents build/verify/ship your app live, with a persistent live-preview rail (right)
 * that embeds the actually-running app. Bespoke cosmic AKIS look; gates are interactive
 * cards inline in the conversation. The preview auto-runs once a build ships.
 */
export function ChatStudio({ api, baseUrl = '', workflows = [], makeClient }: { api: ApiClient; baseUrl?: string; workflows?: WorkflowOption[]; makeClient?: () => EventStreamClient }) {
  const { t } = useI18n()
  const [idea, setIdea] = useState('')
  const [sent, setSent] = useState('')               // the submitted idea (drives the thread)
  const [sessionId, setSessionId] = useState<string | undefined>()
  const [workflowId, setWorkflowId] = useState('')
  const [busy, setBusy] = useState(false)
  const [auto, setAuto] = useState(false)            // autopilot: auto-approve + auto-confirm
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
  const specState = live.view.gates.specApproval?.state
  const pushState = live.view.gates.pushConfirm?.state

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

  // The single build path: the spec/idea becomes a session via the UNCHANGED startSession
  // → the same 4 structural gates + pipeline + History. Used by both the composer and the
  // Chat-to-Build approval (so a chat-authored spec gets no new trust surface or path).
  const startBuild = async (v: string): Promise<void> => {
    const idea = v.trim(); if (!idea || busy) return
    setBusy(true); setActionError(undefined)
    try {
      const s = await api.startSession(idea, workflowId || undefined)
      setSent(idea); setSessionId(s.id); setIdea(''); setReopened(false)
      setRecent(recordRecentBuild({ id: s.id, idea, ts: Date.now() }))
    } catch (e) { setActionError(ApiError.is(e) ? `${e.code ?? 'error'}: ${e.message}` : String(e)) }
    finally { setBusy(false) }
  }
  const send = (): Promise<void> => startBuild(idea)
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

  // Autopilot: when on, satisfy the gates automatically as they open — fully hands-off,
  // while the structural verification gate still enforces a real test pass before push.
  const autoApproved = useRef<string | undefined>(undefined)
  const autoConfirmed = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!auto || !sessionId || busy) return
    if (specState === 'awaiting' && autoApproved.current !== sessionId) { autoApproved.current = sessionId; void approve() }
    else if (pushState === 'awaiting' && autoConfirmed.current !== sessionId) { autoConfirmed.current = sessionId; void confirm() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, sessionId, specState, pushState, busy])

  const canRun = !!sessionId && (status === 'done' || live.view.verified !== undefined)

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_24rem]">
      {/* Conversation column */}
      <section className="flex min-h-[64vh] flex-col rounded-2xl border border-white/10 bg-white/[0.02] shadow-[0_0_60px_rgba(124,58,237,0.06)] backdrop-blur-sm">
        <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-2">
          <AgentRoster view={live.view} />
          <div className="flex shrink-0 items-center gap-2">
            <HistoryMenu builds={recent} onOpen={openSession} />
            {sessionId && <button onClick={newChat} className="shrink-0 rounded border border-white/10 px-2 py-0.5 text-xs text-slate-400 hover:text-slate-200">{t('chat.new')}</button>}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {sessionId
            ? (
              <>
                {!reopened && <AkisTranscript messages={thread} />}
                <RunPipeline
                  view={live.view}
                  onApprove={approve}
                  onConfirm={confirm}
                  busy={busy}
                  api={api}
                  details={<ChatThread messages={live.messages} onApprove={approve} onConfirm={confirm} busy={busy} />}
                />
              </>
            )
            : (
              // Give AkisChat real height: this column is `flex-1` of the studio card, so
              // a full-height flex wrapper lets the chat's scroll area expand instead of
              // collapsing to its content (the spec called this out).
              <div className="flex h-full min-h-[24rem] flex-col gap-4">
                <div className="min-h-0 flex-1">
                  <AkisChat api={api} onBuild={(spec) => void startBuild(spec)} />
                </div>
                {recent.length > 0 && (
                  <div className="border-t border-white/10 pt-3">
                    <div className="mb-2 text-xs uppercase tracking-widest text-slate-500">{t('chat.recent')}</div>
                    <div className="flex flex-wrap gap-2">
                      {recent.map(b => (
                        <button key={b.id} onClick={() => openSession(b)}
                          className="max-w-[16rem] truncate rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-slate-300 hover:border-[#07D1AF]/40 hover:text-slate-100">
                          {b.idea}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          {actionError && <div role="alert" className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{actionError}</div>}
        </div>

        {/* Composer */}
        <form className="flex flex-wrap gap-2 border-t border-white/10 p-3" onSubmit={e => { e.preventDefault(); void send() }}>
          <input aria-label="idea" value={idea} onChange={e => setIdea(e.target.value)} placeholder={t('chat.placeholder')}
            className="min-w-0 flex-1 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-slate-100 placeholder:text-slate-500 focus:border-[#07D1AF] focus:outline-none" />
          {workflows.length > 0 && (
            <select aria-label="workflow" value={workflowId} onChange={e => setWorkflowId(e.target.value)} className="rounded-xl border border-white/10 bg-white/[0.04] px-2 py-2 text-sm text-slate-100">
              <option value="">{t('chat.defaultWorkflow')}</option>
              {workflows.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          )}
          <label title={t('chat.auto.hint')} className={`flex shrink-0 cursor-pointer items-center gap-1.5 rounded-xl border px-3 py-2 text-sm ${auto ? 'border-[#07D1AF]/50 bg-[#07D1AF]/10 text-[#07D1AF]' : 'border-white/10 bg-white/[0.04] text-slate-400'}`}>
            <input type="checkbox" className="sr-only" checked={auto} onChange={e => setAuto(e.target.checked)} aria-label={t('chat.auto')} />
            ⚡ {t('chat.auto')}
          </label>
          <button type="submit" disabled={busy || idea.trim() === ''} className="rounded-xl bg-gradient-to-r from-[#07D1AF] to-violet-500 px-4 py-2 font-semibold text-slate-900 shadow-[0_0_20px_rgba(7,209,175,0.35)] disabled:opacity-40">{t('chat.send')}</button>
        </form>
      </section>

      {/* Live preview rail */}
      <aside className="rounded-2xl border border-white/10 bg-white/[0.02] p-4 backdrop-blur-sm">
        <PreviewPanel view={live.view} onRun={() => void runApp()} busy={busy} canRun={canRun} files={codeFiles} testEvidence={testEvidence} actionError={actionError} />
      </aside>
    </div>
  )
}
