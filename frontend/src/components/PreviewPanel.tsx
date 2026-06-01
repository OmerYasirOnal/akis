import type { SessionView } from '../live/types.js'
import { TestStats } from './TestStats.js'

/**
 * The live-preview surface. Today it shows the produced artifact's URL (the push
 * target) + the test stats. Designed for the local-first vision: when the
 * preview/test-env backend lands, a same-origin `/preview/:id` URL renders the
 * running app in the iframe and TestStats fills with Playwright/Cucumber numbers —
 * no rework, same PreviewState/TestStats shape.
 */
export function PreviewPanel({ view }: { view: SessionView }) {
  const url = view.preview.url
  const embeddable = !!url && url.startsWith('/preview/')
  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-200">Live preview</h3>
        {view.verified !== undefined && (
          <span className={`rounded px-2 py-0.5 text-xs ${view.verified ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-500/20 text-slate-300'}`}>
            {view.verified ? 'verified' : 'unverified'}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-hidden rounded-lg border border-white/10 bg-black/40">
        {embeddable ? (
          <iframe title="preview" src={url} className="h-full w-full" />
        ) : url ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
            <span className="text-xs text-slate-500">Artifact pushed to</span>
            <a href={url} target="_blank" rel="noreferrer" className="break-all text-sm text-cyan-300 underline">{url}</a>
            <span className="text-[11px] text-slate-600">A live in-browser preview appears here once the local run env is enabled.</span>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-slate-600">Preview appears after a verified push.</div>
        )}
      </div>

      <TestStats stats={view.tests} />
    </div>
  )
}
