import { useState, useEffect, useRef, type FormEvent } from 'react'
import type { ApiClient } from '../api/client.js'
import { ApiError } from '../api/client.js'
import { useI18n } from '../i18n/I18nContext.js'
import { Markdown } from '../components/Markdown.js'
import { extractBuildSpec, hasTruncatedSpec } from './buildSpec.js'
import { SpecCard } from './SpecCard.js'
import { loadThread, saveThread, historyForApi, isNearBottom, type AkisMsg } from './akisThread.js'

/**
 * A free-form conversation WITH AKIS, shown before a build starts. AKIS opens with a
 * greeting; the user can ask questions and AKIS replies in persona (POST /api/chat).
 *
 * Replies render as markdown (so **bold**, lists, `code`, --- look right). When a reply
 * carries an `akis-spec` block (the Chat-to-Build contract), the intro renders normally
 * and the spec is promoted to a <SpecCard> with a one-click Approve → `onBuild(spec)`,
 * which reuses the existing build path (no copy-paste).
 *
 * Resilience: a provider 502 / network failure / empty reply renders as a DISTINCT error
 * row (role="alert", rose styling) with a Retry button — never as a faked AK answer — and
 * error rows are EXCLUDED from the history replayed to /api/chat, so a failure can't poison
 * AKIS's context. A 401 clears the session + routes to login (handled in ApiClient). The
 * thread is persisted to localStorage so it survives a build starting (this unmounts) and a
 * page reload. A truncated spec (opening fence, no close) shows an honest "ask AKIS to
 * resend it" notice instead of rendering a half spec as prose with no Build card.
 */
export function AkisChat({ api, onBuild }: { api: ApiClient; onBuild?: (spec: string) => void }) {
  const { t } = useI18n()
  const greeting = t('akis.greeting')
  const [msgs, setMsgs] = useState<AkisMsg[]>(() => {
    const saved = loadThread()
    return saved.length ? saved : [{ role: 'assistant', content: greeting }]
  })
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  // The last user message we tried to send — drives Retry (resends it, untouched).
  const lastUser = useRef<string | undefined>(undefined)
  const inputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true) // false once the user scrolls up (auto-scroll guard)

  // Persist the whole thread on every change so it survives a build start + reload.
  useEffect(() => { saveThread(msgs) }, [msgs])

  // Autofocus the composer on mount so the user can start typing immediately.
  useEffect(() => { inputRef.current?.focus() }, [])

  // Auto-scroll to the latest message/card — UNLESS the user scrolled up to read history.
  useEffect(() => {
    const el = scrollRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [msgs, busy])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (el) stickToBottom.current = isNearBottom(el) // follow only while at the bottom
  }

  // Send `text` to AKIS, appending an error ROW (not a fake AK reply) on any failure.
  const ask = async (text: string): Promise<void> => {
    if (busy) return
    lastUser.current = text
    setBusy(true)
    try {
      const history = historyForApi(msgs, greeting)
      const { reply } = await api.chatWithAkis(text, history)
      const clean = (reply ?? '').trim()
      setMsgs(m => clean
        ? [...m, { role: 'assistant', content: clean }]
        : [...m, { role: 'error', content: t('akis.error.empty') }])
    } catch (err) {
      // A 401 is handled globally (clear user + route to login); surface a brief note.
      const text = ApiError.is(err) && err.status === 401
        ? t('akis.error.unauthorized')
        : ApiError.is(err)
          ? `(${err.code ?? 'error'}) ${err.message}`
          : t('akis.error.network')
      setMsgs(m => [...m, { role: 'error', content: text }])
    } finally { setBusy(false) }
  }

  const send = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    const text = input.trim()
    if (!text || busy) return
    stickToBottom.current = true // a fresh send always follows to the bottom
    setMsgs(m => [...m, { role: 'user', content: text }])
    setInput('')
    await ask(text)
  }

  // Resend the last user message (after a failure) WITHOUT re-adding a user bubble.
  const retry = (): void => {
    if (busy || lastUser.current === undefined) return
    stickToBottom.current = true
    // Drop trailing error rows so a successful retry doesn't leave a stale failure behind.
    setMsgs(m => { const c = [...m]; while (c.length && c[c.length - 1]!.role === 'error') c.pop(); return c })
    void ask(lastUser.current)
  }

  return (
    <div className="flex h-full min-h-[24rem] flex-col gap-3">
      <div ref={scrollRef} onScroll={onScroll} aria-live="polite" className="flex-1 space-y-3 overflow-y-auto">
        {msgs.map((m, i) => {
          if (m.role === 'user') {
            return (
              <div key={i} className="flex justify-end">
                <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-gradient-to-br from-[#07D1AF]/90 to-violet-500/90 px-4 py-2 text-slate-950">{m.content}</div>
              </div>
            )
          }
          if (m.role === 'error') {
            const isLast = i === msgs.length - 1
            return (
              <div key={i} role="alert" className="flex items-start gap-3">
                <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-rose-400/40 bg-rose-500/15 text-[11px] font-black text-rose-300" aria-hidden="true">!</div>
                <div className="min-w-0 max-w-[80%] rounded-2xl rounded-tl-sm border border-rose-500/30 bg-rose-500/10 px-4 py-2.5 text-sm text-rose-200">
                  <div className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-rose-300/80">{t('akis.error.label')}</div>
                  <div>{m.content}</div>
                  {isLast && lastUser.current !== undefined && (
                    <button type="button" onClick={retry} disabled={busy}
                      className="mt-2 rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-1 text-xs font-semibold text-rose-200 hover:border-rose-300/60 disabled:opacity-40">
                      {t('akis.error.retry')}
                    </button>
                  )}
                </div>
              </div>
            )
          }
          // A build-ready spec is detected only when onBuild is wired (the studio flow).
          const detected = onBuild ? extractBuildSpec(m.content) : null
          const truncated = onBuild ? hasTruncatedSpec(m.content) : false
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
                    <>
                      <div className="rounded-2xl rounded-tl-sm border border-white/10 bg-white/[0.04] px-4 py-2.5 text-slate-200">
                        <Markdown content={m.content} />
                      </div>
                      {truncated && (
                        <div role="alert" className="rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-2.5 text-sm text-amber-200">
                          {t('akis.spec.truncated')}
                        </div>
                      )}
                    </>
                  )}
              </div>
            </div>
          )
        })}
        {busy && <div className="ml-11 text-xs text-teal-300">{t('akis.thinking')}</div>}
      </div>
      <form className="flex gap-2" onSubmit={send} aria-busy={busy}>
        <input ref={inputRef} aria-label="ask-akis" value={input} onChange={e => setInput(e.target.value)} placeholder={t('akis.ask')}
          className="min-w-0 flex-1 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-slate-100 placeholder:text-slate-500 focus:border-[#07D1AF] focus:outline-none" />
        <button type="submit" disabled={busy || input.trim() === ''}
          className="rounded-xl border border-white/15 bg-white/[0.04] px-4 py-2 text-sm font-semibold text-slate-200 hover:border-white/30 disabled:opacity-40">{t('akis.send')}</button>
      </form>
    </div>
  )
}
