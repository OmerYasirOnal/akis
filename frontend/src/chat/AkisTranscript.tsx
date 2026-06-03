import { useState } from 'react'
import { useI18n } from '../i18n/I18nContext.js'
import { Markdown } from '../components/Markdown.js'
import type { AkisMsg } from './akisThread.js'

/**
 * A read-only, collapsible view of the "Ask AKIS" conversation that PRODUCED a build.
 *
 * Once a build starts, ChatStudio swaps the live chat for the run pipeline (the chat
 * unmounts), but the thread is persisted in localStorage — so this surfaces it above the
 * pipeline, collapsed by default and scrollable when expanded. The user can always re-read
 * the conversation that led to the build. Error rows are shown distinctly (rose) just as in
 * the live chat; assistant turns render through the shared, XSS-safe <Markdown>.
 */
export function AkisTranscript({ messages }: { messages: AkisMsg[] }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  if (messages.length === 0) return null

  return (
    <div className="mb-4 rounded-xl border border-white/10 bg-white/[0.02]">
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-4 py-2 text-left text-xs font-semibold uppercase tracking-widest text-slate-400 hover:text-slate-200">
        <span>{t('akis.transcript.title')}</span>
        <span className="text-[11px] font-normal normal-case tracking-normal text-slate-500">
          {open ? t('akis.transcript.hide') : t('akis.transcript.show')}
        </span>
      </button>
      {open && (
        <div className="max-h-64 space-y-2 overflow-y-auto border-t border-white/10 px-4 py-3">
          {messages.map((m, i) => {
            if (m.role === 'user') {
              return (
                <div key={i} className="flex justify-end">
                  <div className="max-w-[85%] rounded-xl rounded-br-sm bg-[#07D1AF]/15 px-3 py-1.5 text-sm text-slate-100">{m.content}</div>
                </div>
              )
            }
            if (m.role === 'error') {
              return (
                <div key={i} className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-sm text-rose-200">{m.content}</div>
              )
            }
            return (
              <div key={i} className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-1.5 text-sm text-slate-200">
                <Markdown content={m.content} />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
