import { useState } from 'react'
import { ApiClient, ApiError } from '../api/client.js'
import { useI18n } from '../i18n/I18nContext.js'
import { useLiveChat } from './useLiveChat.js'
import { ChatThread } from './ChatThread.js'
import { PreviewPanel } from '../components/PreviewPanel.js'
import type { WorkflowOption } from '../components/NewSessionForm.js'
import type { EventStreamClient } from '../live/EventStreamClient.js'

/**
 * The AKIS chat studio: a conversational thread (left) where you describe an app and
 * watch the agents build/verify/ship it live, with a persistent live-preview rail
 * (right). Bespoke AKIS look; gates are interactive cards inline in the conversation.
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
  const newChat = (): void => { setSessionId(undefined); setSent(''); setActionError(undefined) }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      {/* Conversation column */}
      <section className="flex min-h-[60vh] flex-col rounded-2xl border border-white/10 bg-white/[0.02]">
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-2">
          <span className="text-xs uppercase tracking-widest text-slate-500">{live.view.status === 'unknown' ? t('chat.idle') : live.view.status}{live.view.provider ? ` · ${live.view.provider}` : ''}</span>
          {sessionId && <button onClick={newChat} className="rounded border border-white/10 px-2 py-0.5 text-xs text-slate-400 hover:text-slate-200">{t('chat.new')}</button>}
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {sessionId
            ? <ChatThread messages={live.messages} onApprove={approve} onConfirm={confirm} busy={busy} />
            : <div className="grid h-full place-items-center text-center text-slate-600"><div><div className="mb-1 text-slate-400">{t('chat.empty.title')}</div><div className="text-xs">{t('chat.empty.hint')}</div></div></div>}
          {actionError && <div className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{actionError}</div>}
        </div>

        {/* Composer */}
        <form className="flex flex-wrap gap-2 border-t border-white/10 p-3" onSubmit={e => { e.preventDefault(); void send() }}>
          <input aria-label="idea" value={idea} onChange={e => setIdea(e.target.value)} placeholder={t('chat.placeholder')}
            className="min-w-0 flex-1 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-slate-100 placeholder:text-slate-600 focus:border-cyan-400 focus:outline-none" />
          {workflows.length > 0 && (
            <select aria-label="workflow" value={workflowId} onChange={e => setWorkflowId(e.target.value)} className="rounded-xl border border-white/10 bg-white/[0.04] px-2 py-2 text-sm text-slate-100">
              <option value="">{t('chat.defaultWorkflow')}</option>
              {workflows.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          )}
          <button type="submit" disabled={busy || idea.trim() === ''} className="rounded-xl bg-gradient-to-r from-cyan-400 to-violet-500 px-4 py-2 font-semibold text-slate-900 disabled:opacity-40">{t('chat.send')}</button>
        </form>
      </section>

      {/* Live preview rail */}
      <aside className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
        <PreviewPanel view={live.view} />
      </aside>
    </div>
  )
}
