import { useState, useEffect, useRef } from 'react'
import type { CodeArtifact, TestEvidence } from '@akis/shared'
import type { SessionView } from '../live/types.js'
import { TestStats } from './TestStats.js'
import { CodeBrowser } from './CodeBrowser.js'
import { TrustReport } from './TrustReport.js'
import { DeviceFrame } from './DeviceFrame.js'
import type { Device } from './DeviceFrame.js'
import { CopyButton } from './CopyButton.js'
import { useI18n } from '../i18n/I18nContext.js'

/**
 * The live-preview surface. Embeds the locally-RUNNING app (same-origin /preview/:id/)
 * in the iframe once it's up, shows the shipped artifact as a link, and offers a
 * "Run app" control to (re)start the local preview. TestStats fills with the verify
 * numbers. Honors the scheme allowlist so an agent-influenced URL can never be a sink.
 *
 * A Preview ⇄ Code ⇄ Trust tablist flips the surface between the live app, a read-only
 * browser of the code the agents wrote (SessionState.code.files), and the Trust report —
 * the auditable structured evidence behind the verified result (SessionState.testEvidence
 * + the critic verdict). The Code tab appears once files exist; the Trust tab once a
 * verification has run (test evidence is present). Both sit right next to the pass badge.
 */
/** After ~125s of a still-running boot we surface a non-blocking "taking longer than expected"
 *  note — so a LOST terminal frame can't leave the spinner pulsing forever (the boot watchdog). */
const BOOT_SLOW_MS = 125_000

export function PreviewPanel({ view, onRun, busy, canRun, files, testEvidence, actionError, device, onDevice, fallbackVerified }: { view: SessionView; onRun?: () => void; busy?: boolean; canRun?: boolean; files?: CodeArtifact['files'] | undefined; testEvidence?: TestEvidence | undefined; actionError?: string | undefined; device: Device; onDevice: (d: Device) => void; fallbackVerified?: boolean }) {
  const { t } = useI18n()
  // VERIFICATION WORDING (review MED): the live view learns `verified` only from the SSE done fold;
  // for an ungated reopen of a parked session the durable snapshot truth arrives as fallbackVerified
  // (never overrides a stream-learned value — `??` keeps the live fold authoritative).
  const shownVerified = view.verified ?? fallbackVerified
  const [tab, setTab] = useState<'preview' | 'code' | 'trust'>('preview')
  // Boot watchdog: while `starting`, arm a single timer; if it elapses before a terminal frame
  // arrives, flip `bootSlow` so a stuck spinner becomes a recoverable "taking longer" note.
  const [bootSlow, setBootSlow] = useState(false)
  const starting = view.preview.starting
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    if (!starting) { setBootSlow(false); return }
    setBootSlow(false)
    timerRef.current = setTimeout(() => setBootSlow(true), BOOT_SLOW_MS)
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [starting])
  const fileCount = files?.length ?? 0
  const hasTrust = testEvidence !== undefined
  // `tab` is local state, but the only control back to Preview is the tablist, which only renders
  // when files OR test evidence exist. If those vanish (New chat / switching to a session with no
  // code/evidence yet) a stale tab would hide the live preview/Run/TestStats with no way back.
  // Derive the active surface so it can never be 'code' without files nor 'trust' without evidence
  // — auto-recovers to Preview the moment the backing data goes.
  const activeTab = tab === 'code' && fileCount === 0 ? 'preview' : tab === 'trust' && !hasTrust ? 'preview' : tab
  const showTablist = fileCount > 0 || hasTrust
  const url = view.preview.url
  // IFRAME PAINT GATE (review HIGH: blank white flash): `preview.starting=false` means the SERVER
  // process is up, NOT that the iframe document has painted — so the bare bg-white iframe used to
  // flash a featureless WHITE rectangle inside the dark shell while it fetched + rendered the app.
  // Track the iframe's own load and keep a dark themed spinner over it until it paints, then fade in.
  const [loaded, setLoaded] = useState(false)
  // REFRESH (view-state only): bump a nonce to remount the iframe so it re-FETCHES the SAME
  // /preview/:id/ url WITHOUT touching the backend preview process (no new gate/security surface —
  // identical sandboxed src). It feeds the iframe's React `key` (force-remount) and re-arms `loaded`
  // below so the dark skeleton shows during reload instead of a white flash.
  const [reloadNonce, setReloadNonce] = useState(0)
  useEffect(() => { setLoaded(false) }, [url, reloadNonce]) // re-arm on (re)run / new session / manual refresh
  // DeviceFrame's Desktop preset caps at the pane's real inner width (min(1280, paneWidth)) so the
  // user sees the full width with horizontal scroll only when narrower. Measure it read-only via a
  // ResizeObserver on the panel root — NO scaling, no per-frame React storm (one setState per resize).
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [paneWidth, setPaneWidth] = useState(0)
  useEffect(() => {
    const el = panelRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width
      if (typeof w === 'number') setPaneWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const previewError = view.preview.error
  const artifact = view.preview.artifactUrl
  const embeddable = !!url && url.startsWith('/preview/')
  const artifactSafe = !!artifact && /^https?:\/\//i.test(artifact)
  // The mock provider runs WITHOUT a real provider key — the produced app is a stub, so the
  // preview is a demo. Only surface the hint for the mock provider (never a real one).
  const isMock = view.provider === 'mock'

  return (
    <div ref={panelRef} className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        {showTablist ? (
          // Preview ⇄ Code ⇄ Trust toggle — Code surfaces once files exist, Trust once a
          // verification has produced structured evidence.
          <div role="tablist" aria-label={t('preview.title')} className="flex rounded-lg border border-white/10 bg-white/[0.03] p-0.5 text-xs">
            {/* Tab buttons crossfade their active/hover state (transition-colors) for a settled toggle
                rather than a hard cut; the tap-down scale is `motion-safe:` (instant under reduced-motion). */}
            <button role="tab" aria-selected={activeTab === 'preview'} onClick={() => setTab('preview')}
              className={`rounded-md px-2.5 py-1 transition-colors motion-safe:active:scale-95 ${activeTab === 'preview' ? 'bg-white/10 text-slate-100' : 'text-slate-400 hover:text-slate-200'}`}>
              {t('preview.tab.preview')}
            </button>
            {fileCount > 0 && (
              <button role="tab" aria-selected={activeTab === 'code'} onClick={() => setTab('code')}
                className={`rounded-md px-2.5 py-1 transition-colors motion-safe:active:scale-95 ${activeTab === 'code' ? 'bg-white/10 text-slate-100' : 'text-slate-400 hover:text-slate-200'}`}>
                {t('preview.tab.code')} <span className="text-slate-500">{fileCount}</span>
              </button>
            )}
            {hasTrust && (
              <button role="tab" aria-selected={activeTab === 'trust'} onClick={() => setTab('trust')}
                className={`rounded-md px-2.5 py-1 transition-colors motion-safe:active:scale-95 ${activeTab === 'trust' ? 'bg-white/10 text-slate-100' : 'text-slate-400 hover:text-slate-200'}`}>
                {t('trust.tab')}
              </button>
            )}
          </div>
        ) : (
          <h3 className="text-sm font-semibold text-slate-200">{t('preview.title')}</h3>
        )}
        <div className="flex items-center gap-2">
          {/* Preview header actions — ONLY when the live URL is embeddable (`/preview/`) AND the
              Preview tab is active (Code/Trust don't show the running app). A non-/preview/ or
              missing URL renders NEITHER button (honesty — no dead affordances). `url` is the same
              relative path the iframe loads, so opening it in a tab is the SAME app at the SAME
              studio origin — no new gate/security surface. */}
          {embeddable && activeTab === 'preview' && url && (
            <>
              {/* Open the running app full-screen in a new tab. `window.open` with the relative
                  `/preview/:id/` resolves against the studio origin (identical to the iframe src);
                  noopener,noreferrer keeps the new tab from reaching back into the studio. */}
              <button
                type="button"
                aria-label={t('preview.openTab')}
                title={t('preview.openTab')}
                onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}
                className="inline-flex items-center rounded border border-white/15 px-2 py-1 text-[11px] text-slate-200 transition hover:bg-white/[0.06] motion-safe:active:scale-95"
              >
                <span aria-hidden="true">↗</span>
              </button>
              {/* Reload the RUNNING app's iframe (bump the nonce → remount → re-fetch the SAME
                  /preview/:id/ url) WITHOUT restarting the backend preview process. No new gate/
                  security surface — it's the same sandboxed iframe at the same path; the dark
                  skeleton re-arms (`loaded` resets) so there's no white flash on reload. */}
              <button
                type="button"
                aria-label={t('preview.refresh')}
                title={t('preview.refresh')}
                onClick={() => setReloadNonce(n => n + 1)}
                className="inline-flex items-center rounded border border-white/15 px-2 py-1 text-[11px] text-slate-200 transition hover:bg-white/[0.06] motion-safe:active:scale-95"
              >
                <span aria-hidden="true">↻</span>
              </button>
              {/* Copy the ABSOLUTE preview URL so it's shareable/openable outside the studio (a bare
                  relative path is useless on its own). Reuses the shared CopyButton idiom. */}
              <CopyButton
                text={new URL(url, location.origin).href}
                label={t('preview.copyUrl')}
                className="motion-safe:active:scale-95"
              />
            </>
          )}
          {/* P1-CORE-1: when the boot is in demo mode (mock provider/verification), the embedded
              "running app" is a demo, not a real-verified build — flag it on the preview itself. */}
          {/* Pills normalized (review): one shape — rounded-md + 1px border + matching padding — so
              the demo/verified/Run cluster reads as a set instead of jittering between styles. */}
          {view.preview.demo && (
            <span role="status" title={t('result.demo.title')}
              className="rounded-md border border-amber-400/30 bg-amber-400/15 px-2 py-0.5 text-xs text-amber-200">
              {t('result.demo.badge')}
            </span>
          )}
          {shownVerified !== undefined && (
            <span className={`rounded-md border px-2 py-0.5 text-xs ${shownVerified ? 'border-emerald-400/30 bg-emerald-500/20 text-emerald-300' : 'border-slate-400/20 bg-slate-500/20 text-slate-300'}`}>
              {shownVerified ? t('preview.verified') : t('preview.unverified')}
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

      {/* A failed Run-app action (rejected startPreview) surfaces here, next to the Run control —
          text-only, never a silent no-op. Suppressed when a preview_status failure is already
          shown in the surface below (the rose error card), so the same failure isn't double-banner'd;
          it stays as the fallback channel for a dropped/missed SSE frame (no preview_status arrives). */}
      {actionError && !previewError && (
        <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{actionError}</div>
      )}

      {activeTab === 'code' ? (
        <CodeBrowser files={files} />
      ) : activeTab === 'trust' ? (
        // The Trust report: the auditable structured evidence behind the verified result.
        // `view.tests.demo` carries the per-run simulated-verification flag (P1-CORE-1), so a
        // demo run's Trust report is flagged as such.
        <TrustReport evidence={testEvidence} codeReview={view.codeReview} demo={view.tests.demo} />
      ) : (
      <>
      {/* Height (Task 4 / SPEC H1 two-region budget): the drawer gives PreviewPanel a BOUNDED
          height (region B = `flex-1 min-h-0`), so the band's old `min-h-[clamp(16rem,55vh,42rem)]`
          would force the parent to overflow → the Code tab's double-scroll. Relax it to a small
          floor (16rem, for the <lg STACKED case with no definite ancestor) while `flex-1` fills the
          bounded parent on lg. The iframe scrolls inside DeviceFrame; this band never imposes a min
          that overflows its bounded parent. */}
      <div className="relative flex min-h-[16rem] flex-1 flex-col overflow-hidden rounded-xl border border-white/10 bg-black/50 shadow-[0_0_40px_rgba(7,209,175,0.08)_inset]">
        {/* Intentional browser-chrome header so the framed area never reads as dead space —
            traffic-light dots, an agent attribution, and (when live) the preview path. */}
        <div className="flex shrink-0 items-center gap-2 border-b border-white/10 bg-white/[0.03] px-3 py-1.5">
          <span className="flex gap-1" aria-hidden>
            <span className="h-2 w-2 rounded-full bg-rose-400/70" />
            <span className="h-2 w-2 rounded-full bg-amber-300/70" />
            <span className="h-2 w-2 rounded-full bg-emerald-400/70" />
          </span>
          {/* Friendly URL label (review): the raw internal /preview/:id/ path read as a debug
              artifact — show a readable label, keep the real path as a hover title. */}
          <span className="flex min-w-0 items-center gap-1 truncate text-[10px] text-slate-400" title={embeddable ? url : undefined}>
            {embeddable ? <><span aria-hidden>🌐</span> <span className="truncate">{t('preview.urlLabel')}</span></> : t('preview.attribution')}
          </span>
        </div>

        <div className="relative flex-1 overflow-hidden bg-slate-950">
          {embeddable && !previewError ? (
            // The framed app is UNTRUSTED agent-generated code served same-origin from
            // /preview/:id/. Deliberately NO allow-same-origin: that would let it reach
            // the AKIS origin (session cookie, parent DOM). allow-scripts in an opaque
            // origin is enough to run a self-contained app. (Apps needing real same-origin
            // storage are a deferred cross-origin-preview hardening.)
            <>
              {/* LETTERBOX moved into DeviceFrame (Task 4): the device toggle drives the iframe's
                  LOGICAL width per preset (responsive 100% / mobile 390 / desktop min(1280,paneWidth)),
                  centered via `mx-auto` on a dark surface — replacing the old fixed `max-w-[1100px]`.
                  The iframe element below is wrapped VERBATIM: same src/sandbox/allow/onLoad and the
                  loaded-opacity transition; DeviceFrame only sets the WIDTH of its container. */}
              <DeviceFrame device={device} onDevice={onDevice} paneWidth={paneWidth} tab={activeTab}>
                {/* `key` includes reloadNonce so a Refresh click REMOUNTS the iframe (re-fetches the
                    SAME src) — sandbox/allow/src path are untouched (no security/path change). */}
                <iframe key={reloadNonce} title={t('preview.iframeTitle')} src={url} onLoad={() => setLoaded(true)}
                  className={`block h-full w-full bg-white transition-opacity duration-300 ${loaded ? 'opacity-100' : 'opacity-0'}`}
                  sandbox="allow-scripts allow-forms allow-popups" allow="clipboard-write" />
              </DeviceFrame>
              {/* Dark themed skeleton over the iframe until it actually PAINTS — no white flash. */}
              {!loaded && (
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 bg-slate-950">
                  <span className="h-6 w-6 animate-spin rounded-full border-2 border-teal-400/40 border-t-teal-300" />
                  <span className="text-xs text-slate-500">{t('preview.rendering')}</span>
                </div>
              )}
            </>
          ) : previewError ? (
            // A failed/unsupported boot is a RECOVERABLE failure — never a silent collapse to the
            // empty state. Show a rose card with the backend's reason as TEXT (XSS-safe, no HTML)
            // plus an explicit Retry. The Retry is shown even when !canRun: a boot that already ran
            // proves the session is runnable, so the human can always try again.
            <div role="alert" className="akis-fade-in flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
              <div className="max-w-md rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-rose-300 sm:max-w-lg">
                <div className="text-sm font-semibold">
                  {t(previewError.status === 'unsupported' ? 'preview.unsupported' : 'preview.failed')}
                </div>
                {previewError.reason && (
                  <div className="mt-1 break-words text-xs text-rose-200/90">{previewError.reason}</div>
                )}
              </div>
              {onRun && (
                <button onClick={onRun} disabled={busy}
                  className="mt-1 rounded-lg border border-teal-400/30 bg-teal-400/10 px-3 py-1.5 text-sm font-semibold text-teal-200 hover:bg-teal-400/20 disabled:opacity-40">
                  ▶ {t('preview.retry')}
                </button>
              )}
            </div>
          ) : view.preview.starting ? (
            <div className="akis-fade-in flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
              <span className="h-6 w-6 animate-spin rounded-full border-2 border-teal-400/40 border-t-teal-300" />
              <span className="text-xs text-slate-400">{t('preview.booting')}</span>
              {/* Boot watchdog: a still-running boot past the threshold gets a non-blocking note +
                  Retry, so a lost terminal frame can't strand the spinner forever. */}
              {bootSlow && (
                <div className="flex flex-col items-center gap-1.5">
                  <span className="text-[11px] text-amber-200/90">{t('preview.bootSlow')}</span>
                  {onRun && (
                    <button onClick={onRun} disabled={busy}
                      className="rounded-md border border-teal-400/30 bg-teal-400/10 px-2.5 py-1 text-xs text-teal-200 hover:bg-teal-400/20 disabled:opacity-40">
                      ▶ {t('preview.retry')}
                    </button>
                  )}
                </div>
              )}
            </div>
          ) : view.preview.stopped ? (
            // STOPPED ≠ never-run (review): a stopped preview (cap eviction / stopAll / teardown)
            // reads as a recoverable PAUSE in muted slate, not the blank first-run empty state.
            <div className="akis-fade-in flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
              <span aria-hidden className="text-lg text-slate-500">⏸</span>
              <span className="text-sm text-slate-400">{t('preview.stopped')}</span>
              {onRun && canRun && (
                <button onClick={onRun} disabled={busy}
                  className="mt-1 rounded-lg border border-teal-400/30 bg-teal-400/10 px-3 py-1.5 text-sm font-semibold text-teal-200 hover:bg-teal-400/20 disabled:opacity-40">
                  ▶ {t('preview.run')}
                </button>
              )}
            </div>
          ) : (
            <div className="akis-fade-in flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
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

      {/* `testEvidence` lets the strip surface the REAL scenario count (the same structured
          evidence the Trust tab renders) when the live counters don't fire — never invents data. */}
      <TestStats stats={view.tests} evidence={testEvidence} />
      </>
      )}
    </div>
  )
}
