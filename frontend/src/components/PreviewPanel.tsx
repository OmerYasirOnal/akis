import type { SessionView } from '../live/types.js'
import { TestStats } from './TestStats.js'
import { useI18n } from '../i18n/I18nContext.js'

/**
 * The live-preview surface. Embeds the locally-RUNNING app (same-origin /preview/:id/)
 * in the iframe once it's up, shows the shipped artifact as a link, and offers a
 * "Run app" control to (re)start the local preview. TestStats fills with the verify
 * numbers. Honors the scheme allowlist so an agent-influenced URL can never be a sink.
 */
export function PreviewPanel({ view, onRun, busy, canRun }: { view: SessionView; onRun?: () => void; busy?: boolean; canRun?: boolean }) {
  const { t } = useI18n()
  const url = view.preview.url
  const artifact = view.preview.artifactUrl
  const embeddable = !!url && url.startsWith('/preview/')
  const artifactSafe = !!artifact && /^https?:\/\//i.test(artifact)

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-200">{t('preview.title')}</h3>
        <div className="flex items-center gap-2">
          {view.verified !== undefined && (
            <span className={`rounded px-2 py-0.5 text-xs ${view.verified ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-500/20 text-slate-300'}`}>
              {view.verified ? t('preview.verified') : t('preview.unverified')}
            </span>
          )}
          {onRun && canRun && (
            <button onClick={onRun} disabled={busy}
              className="rounded-md border border-cyan-400/30 bg-cyan-400/10 px-2 py-0.5 text-xs text-cyan-200 hover:bg-cyan-400/20 disabled:opacity-40">
              {view.preview.starting ? t('preview.starting') : `▶ ${t('preview.run')}`}
            </button>
          )}
        </div>
      </div>

      <div className="relative flex-1 overflow-hidden rounded-xl border border-white/10 bg-black/50 shadow-[0_0_40px_rgba(56,189,248,0.08)_inset]">
        {embeddable ? (
          // The framed app is UNTRUSTED agent-generated code served same-origin from
          // /preview/:id/. Deliberately NO allow-same-origin: that would let it reach
          // the AKIS origin (session cookie, parent DOM). allow-scripts in an opaque
          // origin is enough to run a self-contained app. (Apps needing real same-origin
          // storage are a deferred cross-origin-preview hardening.)
          <iframe title="preview" src={url} className="h-full w-full bg-white" sandbox="allow-scripts allow-forms allow-popups" />
        ) : view.preview.starting ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <span className="h-6 w-6 animate-spin rounded-full border-2 border-cyan-400/40 border-t-cyan-300" />
            <span className="text-xs text-slate-400">{t('preview.booting')}</span>
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
            <span className="text-sm text-slate-500">{t('preview.empty')}</span>
            {onRun && canRun && (
              <button onClick={onRun} disabled={busy}
                className="mt-1 rounded-lg bg-gradient-to-r from-cyan-400 to-violet-500 px-3 py-1.5 text-sm font-semibold text-slate-900 disabled:opacity-40">
                ▶ {t('preview.run')}
              </button>
            )}
          </div>
        )}
      </div>

      {artifact && (
        <div className="truncate text-[11px] text-slate-500">
          {t('preview.shipped')}{' '}
          {artifactSafe
            ? <a href={artifact} target="_blank" rel="noreferrer" className="text-cyan-300/80 underline">{artifact}</a>
            : <span className="text-slate-400">{artifact}</span>}
        </div>
      )}

      <TestStats stats={view.tests} />
    </div>
  )
}
