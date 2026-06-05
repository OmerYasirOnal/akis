import { useEffect, useState } from 'react'
import type { ApiClient, PublishProfileStatus } from '../api/client.js'
import type { PublishRecord } from '@akis/shared'
import { useI18n } from '../i18n/I18nContext.js'

/**
 * "Publish to your own server" — shown next to the Trust Report on a `done` session. Deploy is a
 * POST-`done`, OPTIONAL, NON-GATING action: it can never gate/block/fake verification. On ok:true
 * it shows the live URL (+ a reachable:false caution = open the port). On ok:false it shows the
 * honest failure reason (a logTail summary). Disabled (with a hint) when no publish destination is
 * configured — the owner sets one in Settings → Publish destination.
 */
export function PublishButton({ sessionId, api }: { sessionId: string; api: ApiClient }) {
  const { t } = useI18n()
  const [status, setStatus] = useState<PublishProfileStatus | undefined>()
  const [busy, setBusy] = useState(false)
  const [record, setRecord] = useState<PublishRecord | undefined>()
  const [err, setErr] = useState<string | undefined>()

  useEffect(() => { void api.publishStatus().then(setStatus).catch(() => setStatus({ configured: false, present: false })) }, [api])

  const configured = !!status?.present
  const run = async (): Promise<void> => {
    setBusy(true); setErr(undefined); setRecord(undefined)
    try {
      const s = await api.publish(sessionId)
      setRecord(s.publish)
    } catch (e) { setErr(String(e)) }
    finally { setBusy(false) }
  }

  return (
    <div className="mb-3 rounded-xl border border-white/10 bg-white/[0.02] p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-semibold text-slate-200">{t('publish.title')}</div>
        <button
          type="button"
          onClick={() => void run()}
          disabled={busy || !configured}
          title={configured ? undefined : t('publish.notConfigured')}
          className="rounded-lg border border-teal-400/30 bg-teal-400/10 px-3 py-1.5 text-xs font-semibold text-teal-200 transition hover:bg-teal-400/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? t('publish.publishing') : t('publish.publish')}
        </button>
      </div>

      {!configured && status !== undefined && (
        <div className="mt-2 text-xs text-slate-500">{t('publish.notConfigured')}</div>
      )}

      {err && <div role="alert" className="mt-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2 py-1.5 text-xs text-rose-300">{err}</div>}

      {record && (
        record.ok ? (
          <div className="mt-2 flex flex-col gap-1">
            <div role="status" className="rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-2 py-1.5 text-xs text-emerald-200">
              {record.url
                ? <>{t('publish.live')} <a href={record.url} target="_blank" rel="noreferrer" className="font-mono underline hover:text-emerald-100">{record.url}</a></>
                : t('publish.deployed')}
            </div>
            {record.reachable === false && (
              <div className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-2 py-1.5 text-xs text-amber-200">{t('publish.unreachable')}</div>
            )}
          </div>
        ) : (
          <div className="mt-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2 py-1.5 text-xs text-rose-300">
            <div className="font-semibold">{t('publish.failed')}</div>
            {record.logTail.length > 0 && (
              <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] text-rose-200/90">{record.logTail.join('\n')}</pre>
            )}
          </div>
        )
      )}
    </div>
  )
}
