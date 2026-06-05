import { useState } from 'react'
import type { ApiClient } from '../api/client.js'
import { useI18n } from '../i18n/I18nContext.js'

/**
 * The exportable CLIENT-FACING trust report (the GTM plan's first commercial build item):
 * fetches the server-rendered Markdown artifact (a pure projection of the facts the session
 * earned through the gates — simulated runs are loudly labeled, an unverified run renders an
 * honest "push blocked" report) and offers Copy + Download. Rendered as PLAIN TEXT in a
 * <pre> — the report is a document to hand over, not HTML to interpret (and stays XSS-inert).
 */
export function TrustReportCard({ sessionId, api }: { sessionId: string; api: ApiClient }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [md, setMd] = useState<string | undefined>()
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle')
  const [copied, setCopied] = useState(false)

  const load = async (): Promise<void> => {
    setState('loading')
    try { setMd(await api.getTrustReportMarkdown(sessionId)); setState('idle') } catch { setState('error') }
  }
  const toggle = (): void => {
    const next = !open
    setOpen(next)
    if (next && md === undefined) void load()
  }
  const copy = async (): Promise<void> => {
    if (!md) return
    try { await navigator.clipboard.writeText(md); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* clipboard denied */ }
  }
  const download = (): void => {
    if (!md) return
    const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }))
    const a = document.createElement('a')
    a.href = url; a.download = `trust-report-${sessionId}.md`; a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03]">
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-slate-200 hover:text-teal-200"
        aria-expanded={open}
      >
        <span aria-hidden>📋</span>
        {t('report.title')}
        <span className="ml-auto text-slate-500">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="border-t border-white/10 px-3 py-2">
          <p className="mb-2 text-[11px] text-slate-400">{t('report.hint')}</p>
          {state === 'loading' && <p className="text-[11px] text-slate-400">{t('report.loading')}</p>}
          {state === 'error' && (
            <p className="text-[11px] text-rose-300">
              {t('report.error')}{' '}
              <button type="button" onClick={() => void load()} className="underline hover:text-rose-200">{t('report.retry')}</button>
            </p>
          )}
          {md !== undefined && (
            <>
              <div className="mb-2 flex gap-2">
                <button type="button" onClick={() => void copy()} className="rounded border border-white/15 px-2 py-1 text-[11px] text-slate-200 hover:bg-white/[0.06]">
                  {copied ? t('report.copied') : t('report.copy')}
                </button>
                <button type="button" onClick={download} className="rounded border border-white/15 px-2 py-1 text-[11px] text-slate-200 hover:bg-white/[0.06]">
                  {t('report.download')}
                </button>
              </div>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-black/40 p-3 text-[11px] leading-relaxed text-slate-300">{md}</pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}
