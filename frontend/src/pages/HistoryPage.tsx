import { useEffect, useState } from 'react'
import type { ApiClient, SessionSummary } from '../api/client.js'
import { useI18n } from '../i18n/I18nContext.js'
import { useRouter } from '../router/router.js'
import { ideaTitle } from '../chat/recentBuilds.js'

/** Status → tone token for the small build-status pill. */
function tone(status: string): string {
  if (status === 'done') return 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300'
  if (status === 'failed' || status === 'cancelled') return 'border-rose-400/30 bg-rose-400/10 text-rose-300'
  if (status === 'running' || status === 'started') return 'border-[#07D1AF]/30 bg-[#07D1AF]/10 text-[#07D1AF]'
  return 'border-white/10 bg-white/5 text-slate-300'
}

/**
 * The dedicated /history page: the user's full build history (GET /sessions/mine), each row
 * showing the idea + status. Clicking a build opens it in the Studio by navigating to
 * /?s=<id> — ChatStudio reads ?s= on mount and replays the run. Robust to an empty list and
 * a failed fetch (both render a graceful state, never a crash).
 */
export function HistoryPage({ api }: { api: ApiClient }) {
  const { t } = useI18n()
  const { navigate } = useRouter()
  const [builds, setBuilds] = useState<SessionSummary[] | undefined>()
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    void api.listMySessions()
      .then(list => { if (!cancelled) setBuilds(list) })
      .catch(() => { if (!cancelled) { setBuilds([]); setFailed(true) } })
    return () => { cancelled = true }
  }, [api])

  const open = (id: string): void => navigate(`/?s=${encodeURIComponent(id)}`)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="bg-gradient-to-r from-[#07D1AF] via-cyan-200 to-violet-300 bg-clip-text text-2xl font-extrabold text-transparent">{t('history.title')}</h1>
        <p className="mt-1 text-sm text-slate-400">{t('history.sub')}</p>
      </div>

      {builds === undefined && !failed ? (
        <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.02] px-4 py-6 text-sm text-slate-400">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#07D1AF]/40 border-t-[#07D1AF]" />
          {t('history.loading')}
        </div>
      ) : builds && builds.length === 0 ? (
        <div className="grid min-h-[50vh] place-items-center">
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] px-8 py-10 text-center text-sm text-slate-400">
            {t('history.empty')}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {builds?.map(b => (
            <button
              key={b.id}
              onClick={() => open(b.id)}
              className="group flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.02] px-4 py-3 text-left transition hover:border-[#07D1AF]/40 hover:bg-white/[0.04]"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-slate-100">{ideaTitle(b.idea) || t('history.untitled')}</div>
                <div className="mt-1 flex items-center gap-2">
                  <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${tone(b.status)}`}>{b.status}</span>
                  {b.verified && <span className="text-[10px] font-medium text-emerald-300">✓ {t('history.verified')}</span>}
                </div>
              </div>
              <span className="shrink-0 rounded-lg border border-white/10 px-3 py-1 text-xs text-slate-300 transition group-hover:border-[#07D1AF]/40 group-hover:text-[#07D1AF]">
                {t('history.openStudio')} →
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
