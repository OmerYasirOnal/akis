import { useState, type FormEvent } from 'react'
import type { ApiClient } from '../api/client.js'
import { ApiError } from '../api/client.js'
import { useI18n } from '../i18n/I18nContext.js'
import { Markdown } from '../components/Markdown.js'
import { extractBuildSpec } from './buildSpec.js'
import { SpecCard } from './SpecCard.js'

interface Msg { role: 'user' | 'assistant'; content: string }

/**
 * A free-form conversation WITH AKIS, shown before a build starts. AKIS opens with a
 * greeting; the user can ask questions and AKIS replies in persona (POST /api/chat).
 *
 * Replies render as markdown (so **bold**, lists, `code`, --- look right). When a reply
 * carries an `akis-spec` block (the Chat-to-Build contract), the intro renders normally
 * and the spec is promoted to a <SpecCard> with a one-click Approve → `onBuild(spec)`,
 * which reuses the existing build path (no copy-paste).
 */
export function AkisChat({ api, onBuild }: { api: ApiClient; onBuild?: (spec: string) => void }) {
  const { t } = useI18n()
  const [msgs, setMsgs] = useState<Msg[]>([{ role: 'assistant', content: t('akis.greeting') }])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)

  const send = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    const text = input.trim()
    if (!text || busy) return
    const history = msgs.filter(m => m.content !== t('akis.greeting') || m.role === 'user')
    setMsgs(m => [...m, { role: 'user', content: text }])
    setInput(''); setBusy(true)
    try {
      const { reply } = await api.chatWithAkis(text, history)
      setMsgs(m => [...m, { role: 'assistant', content: reply }])
    } catch (err) {
      setMsgs(m => [...m, { role: 'assistant', content: ApiError.is(err) ? `(${err.code ?? 'error'}) ${err.message}` : String(err) }])
    } finally { setBusy(false) }
  }

  return (
    <div className="flex h-full min-h-[24rem] flex-col gap-3">
      <div className="flex-1 space-y-3 overflow-y-auto">
        {msgs.map((m, i) => {
          if (m.role !== 'assistant') {
            return (
              <div key={i} className="flex justify-end">
                <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-gradient-to-br from-[#07D1AF]/90 to-violet-500/90 px-4 py-2 text-slate-950">{m.content}</div>
              </div>
            )
          }
          // A build-ready spec is detected only when onBuild is wired (the studio flow).
          const detected = onBuild ? extractBuildSpec(m.content) : null
          return (
            <div key={i} className="flex items-start gap-3">
              <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-[#07D1AF] to-violet-500 text-[10px] font-black text-slate-950">AK</div>
              <div className="min-w-0 max-w-[80%] space-y-3">
                {detected
                  ? (
                    <>
                      {detected.intro && (
                        <div className="rounded-2xl rounded-tl-sm border border-white/10 bg-white/[0.04] px-4 py-2.5 text-slate-200">
                          <Markdown content={detected.intro} />
                        </div>
                      )}
                      <SpecCard spec={detected.spec} onBuild={onBuild!} />
                    </>
                  )
                  : (
                    <div className="rounded-2xl rounded-tl-sm border border-white/10 bg-white/[0.04] px-4 py-2.5 text-slate-200">
                      <Markdown content={m.content} />
                    </div>
                  )}
              </div>
            </div>
          )
        })}
        {busy && <div className="ml-11 text-xs text-teal-300">{t('akis.thinking')}</div>}
      </div>
      <form className="flex gap-2" onSubmit={send}>
        <input aria-label="ask-akis" value={input} onChange={e => setInput(e.target.value)} placeholder={t('akis.ask')}
          className="min-w-0 flex-1 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-slate-100 placeholder:text-slate-500 focus:border-[#07D1AF] focus:outline-none" />
        <button type="submit" disabled={busy || input.trim() === ''}
          className="rounded-xl border border-white/15 bg-white/[0.04] px-4 py-2 text-sm font-semibold text-slate-200 hover:border-white/30 disabled:opacity-40">{t('akis.send')}</button>
      </form>
    </div>
  )
}
