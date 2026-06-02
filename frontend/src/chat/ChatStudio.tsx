import { useState, useEffect, useRef } from 'react'
import { ApiClient, ApiError } from '../api/client.js'
import { useI18n } from '../i18n/I18nContext.js'
import { useLiveChat } from './useLiveChat.js'
import { ChatThread } from './ChatThread.js'
import { PreviewPanel } from '../components/PreviewPanel.js'
import { AgentRoster } from '../components/AgentRoster.js'
import type { WorkflowOption } from '../live/types.js'
import type { EventStreamClient } from '../live/EventStreamClient.js'

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
  const [actionError, setActionError] = useState<string | undefined>()

  const live = useLiveChat(sessionId, sent, api, baseUrl, makeClient)
  const status = live.view.status

  const send = async (): Promise<void> => {
    const v = idea.trim(); if (!v || busy) return
    setBusy(true); setActionError(undefined)
    try {
      const s = await api.startSession(v, workflowId || undefined)
      setSent(v); setSessionId(s.id); setIdea('')
    } catch (e) { setActionError(ApiError.is(e) ? `${e.code ?? 'error'}: ${e.message}` : String(e)) }
    finally { setBusy(false) }
  }
  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true); setActionError(undefined)
    try { await fn() } catch (e) { setActionError(ApiError.is(e) ? `${e.code ?? 'error'}: ${e.message}` : String(e)) } finally { setBusy(false) }
  }
  const approve = (): Promise<void> => act(async () => { if (sessionId) { await api.approve(sessionId); await api.run(sessionId) } })
  const confirm = (): Promise<void> => act(async () => { if (sessionId) await api.confirm(sessionId) })
  const runApp = (): Promise<void> => act(async () => { if (sessionId) await api.startPreview(sessionId) })
  const newChat = (): void => { setSessionId(undefined); setSent(''); setActionError(undefined) }

  // Auto-run the local preview once a build ships, so the app appears live with no
  // extra click (once per session; the user can re-run from the rail). Best-effort.
  const autoRan = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (sessionId && status === 'done' && autoRan.current !== sessionId) {
      autoRan.current = sessionId
      void api.startPreview(sessionId).catch(() => { /* surfaced via preview_status / manual run */ })
    }
  }, [sessionId, status, api])

  const canRun = !!sessionId && (status === 'done' || live.view.verified !== undefined)

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_24rem]">
      {/* Conversation column */}
      <section className="flex min-h-[64vh] flex-col rounded-2xl border border-white/10 bg-white/[0.02] shadow-[0_0_60px_rgba(124,58,237,0.06)] backdrop-blur-sm">
        <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-2">
          <AgentRoster view={live.view} />
          {sessionId && <button onClick={newChat} className="shrink-0 rounded border border-white/10 px-2 py-0.5 text-xs text-slate-400 hover:text-slate-200">{t('chat.new')}</button>}
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {sessionId
            ? <ChatThread messages={live.messages} onApprove={approve} onConfirm={confirm} busy={busy} />
            : (
              <div className="flex h-full items-start gap-3">
                <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-[#07D1AF] to-violet-500 text-[10px] font-black text-slate-950">AK</div>
                <div className="max-w-[80%] rounded-2xl rounded-tl-sm border border-white/10 bg-white/[0.04] px-4 py-3 text-slate-200">{t('akis.greeting')}</div>
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
          <button type="submit" disabled={busy || idea.trim() === ''} className="rounded-xl bg-gradient-to-r from-[#07D1AF] to-violet-500 px-4 py-2 font-semibold text-slate-900 shadow-[0_0_20px_rgba(7,209,175,0.35)] disabled:opacity-40">{t('chat.send')}</button>
        </form>
      </section>

      {/* Live preview rail */}
      <aside className="rounded-2xl border border-white/10 bg-white/[0.02] p-4 backdrop-blur-sm">
        <PreviewPanel view={live.view} onRun={() => void runApp()} busy={busy} canRun={canRun} />
      </aside>
    </div>
  )
}
