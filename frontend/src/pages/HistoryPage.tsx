import { useEffect, useState } from 'react'
import type { ApiClient, SessionSummary } from '../api/client.js'
import { SectionTitle } from '../ui/kit.js'
import { useI18n } from '../i18n/I18nContext.js'
import { useRouter } from '../router/router.js'
import { ideaTitle } from '../chat/recentBuilds.js'
import { statusSignal } from '../chat/statusLabel.js'

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
      <SectionTitle sub={t('history.sub')}>{t('history.title')}</SectionTitle>

      {builds === undefined && !failed ? (
        <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.02] px-4 py-6 text-sm text-slate-400">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#07D1AF]/40 border-t-[#07D1AF]" />
          {t('history.loading')}
        </div>
      ) : builds && builds.length === 0 ? (
        <div className="grid min-h-[50vh] place-items-center">
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] px-8 py-10 text-center text-sm text-slate-400">
            <p>{t('history.empty')}</p>
            <button onClick={() => navigate('/')}
              className="mt-4 inline-flex rounded-lg bg-gradient-to-r from-[#07D1AF] to-violet-500 px-4 py-2 text-sm font-semibold text-slate-900">
              {t('nav.dashboard')} →
            </button>
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
                  {/* P1-7: localized human label + meaningful tone — never the raw uppercased enum. */}
                  <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${statusSignal(b.status).tone}`}>{t(statusSignal(b.status).labelKey)}</span>
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
