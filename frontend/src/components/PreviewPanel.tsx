import { useState } from 'react'
import type { CodeArtifact } from '@akis/shared'
import type { SessionView } from '../live/types.js'
import { TestStats } from './TestStats.js'
import { CodeBrowser } from './CodeBrowser.js'
import { useI18n } from '../i18n/I18nContext.js'

/**
 * The live-preview surface. Embeds the locally-RUNNING app (same-origin /preview/:id/)
 * in the iframe once it's up, shows the shipped artifact as a link, and offers a
 * "Run app" control to (re)start the local preview. TestStats fills with the verify
 * numbers. Honors the scheme allowlist so an agent-influenced URL can never be a sink.
 *
 * A Preview ⇄ Code toggle flips the surface to a read-only browser of the code the agents
 * wrote (SessionState.code.files), so the verified artifact sits right next to the pass
 * badge. The toggle only appears once files exist.
 */
export function PreviewPanel({ view, onRun, busy, canRun, files }: { view: SessionView; onRun?: () => void; busy?: boolean; canRun?: boolean; files?: CodeArtifact['files'] | undefined }) {
  const { t } = useI18n()
  const [tab, setTab] = useState<'preview' | 'code'>('preview')
  const fileCount = files?.length ?? 0
  const url = view.preview.url
  const artifact = view.preview.artifactUrl
  const embeddable = !!url && url.startsWith('/preview/')
  const artifactSafe = !!artifact && /^https?:\/\//i.test(artifact)
  // The mock provider runs WITHOUT a real provider key — the produced app is a stub, so the
  // preview is a demo. Only surface the hint for the mock provider (never a real one).
  const isMock = view.provider === 'mock'

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        {fileCount > 0 ? (
          // Preview ⇄ Code toggle — surfaces once the agents have written files.
          <div role="tablist" aria-label={t('preview.title')} className="flex rounded-lg border border-white/10 bg-white/[0.03] p-0.5 text-xs">
            <button role="tab" aria-selected={tab === 'preview'} onClick={() => setTab('preview')}
              className={`rounded-md px-2.5 py-1 ${tab === 'preview' ? 'bg-white/10 text-slate-100' : 'text-slate-400 hover:text-slate-200'}`}>
              {t('preview.tab.preview')}
            </button>
            <button role="tab" aria-selected={tab === 'code'} onClick={() => setTab('code')}
              className={`rounded-md px-2.5 py-1 ${tab === 'code' ? 'bg-white/10 text-slate-100' : 'text-slate-400 hover:text-slate-200'}`}>
              {t('preview.tab.code')} <span className="text-slate-500">{fileCount}</span>
            </button>
          </div>
        ) : (
          <h3 className="text-sm font-semibold text-slate-200">{t('preview.title')}</h3>
        )}
        <div className="flex items-center gap-2">
          {/* P1-CORE-1: when the boot is in demo mode (mock provider/verification), the embedded
              "running app" is a demo, not a real-verified build — flag it on the preview itself. */}
          {view.preview.demo && (
            <span role="status" title={t('result.demo.title')}
              className="rounded border border-amber-400/30 bg-amber-400/15 px-2 py-0.5 text-xs text-amber-200">
              {t('result.demo.badge')}
            </span>
          )}
          {view.verified !== undefined && (
            <span className={`rounded px-2 py-0.5 text-xs ${view.verified ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-500/20 text-slate-300'}`}>
              {view.verified ? t('preview.verified') : t('preview.unverified')}
            </span>
          )}
          {onRun && canRun && (
            <button onClick={onRun} disabled={busy}
              className="rounded-md border border-teal-400/30 bg-teal-400/10 px-2 py-0.5 text-xs text-teal-200 hover:bg-teal-400/20 disabled:opacity-40">
              {view.preview.starting ? t('preview.starting') : `▶ ${t('preview.run')}`}
            </button>
          )}
        </div>
      </div>

      {tab === 'code' ? (
        <CodeBrowser files={files} />
      ) : (
      <>
      <div className="relative flex flex-1 flex-col overflow-hidden rounded-xl border border-white/10 bg-black/50 shadow-[0_0_40px_rgba(7,209,175,0.08)_inset]">
        {/* Intentional browser-chrome header so the framed area never reads as dead space —
            traffic-light dots, an agent attribution, and (when live) the preview path. */}
        <div className="flex shrink-0 items-center gap-2 border-b border-white/10 bg-white/[0.03] px-3 py-1.5">
          <span className="flex gap-1" aria-hidden>
            <span className="h-2 w-2 rounded-full bg-rose-400/70" />
            <span className="h-2 w-2 rounded-full bg-amber-300/70" />
            <span className="h-2 w-2 rounded-full bg-emerald-400/70" />
          </span>
          <span className="truncate text-[10px] text-slate-400">{embeddable ? url : t('preview.attribution')}</span>
        </div>

        <div className="relative flex-1 overflow-hidden">
          {embeddable ? (
            // The framed app is UNTRUSTED agent-generated code served same-origin from
            // /preview/:id/. Deliberately NO allow-same-origin: that would let it reach
            // the AKIS origin (session cookie, parent DOM). allow-scripts in an opaque
            // origin is enough to run a self-contained app. (Apps needing real same-origin
            // storage are a deferred cross-origin-preview hardening.)
            <iframe title="preview" src={url} className="h-full w-full bg-white" sandbox="allow-scripts allow-forms allow-popups" />
          ) : view.preview.starting ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <span className="h-6 w-6 animate-spin rounded-full border-2 border-teal-400/40 border-t-teal-300" />
              <span className="text-xs text-slate-400">{t('preview.booting')}</span>
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
              <span className="text-sm text-slate-500">{t('preview.empty')}</span>
              {onRun && canRun && (
                <button onClick={onRun} disabled={busy}
                  className="mt-1 rounded-lg bg-gradient-to-r from-teal-400 to-violet-500 px-3 py-1.5 text-sm font-semibold text-slate-900 disabled:opacity-40">
                  ▶ {t('preview.run')}
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {isMock && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2 text-[11px] text-amber-200/90">
          <span aria-hidden>ℹ</span>
          <span>{t('preview.mockNote')}</span>
        </div>
      )}

      {artifact && (
        <div className="truncate text-[11px] text-slate-500">
          {t('preview.shipped')}{' '}
          {artifactSafe
            ? <a href={artifact} target="_blank" rel="noreferrer" className="text-teal-300/80 underline">{artifact}</a>
            : <span className="text-slate-400">{artifact}</span>}
        </div>
      )}

      <TestStats stats={view.tests} />
      </>
      )}
    </div>
  )
}
