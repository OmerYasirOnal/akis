import { memo, useEffect, useRef, useState } from 'react'
import { ApiClient, ApiError } from '../api/client.js'
import { useI18n } from '../i18n/I18nContext.js'
import type { EventStreamClient } from '../live/EventStreamClient.js'
import type { SessionView } from '../live/types.js'
import { useLiveChat } from './useLiveChat.js'
import { RunPipeline } from './RunPipeline.js'
import { ChatBubble } from './ChatThread.js'
import { ideaTitle } from './recentBuilds.js'
import { actionErrorText } from './actionError.js'

/**
 * ONE inline build, anchored at the array slot where its SpecCard was approved (the spine).
 *
 * A run-block IS a build: it mounts its OWN useLiveChat (so N run-blocks = N independent
 * subscriptions, each coalescing per animation-frame on its own — no shared whole-studio
 * flicker), renders the proven 5-stage trust strip as a COMPACT HEADER by reusing RunPipeline
 * verbatim (its TrustLedger, the spec/push gate buttons, the critic/verify/push recovery and the
 * Stop control are all preserved — gates stay structural + server-minted), and BELOW the header
 * the chronological agent work as inline localized bubbles via foldRunBubbles → ChatThread's
 * shared sub-renderers (no strip-vs-bubble duplication; English narration stays suppressed).
 *
 * `terminal`: an OLDER, already-finished run never stays live — useLiveChat folds its /log ONCE
 * then closes (no open EventSource). Only the ACTIVE run streams. A reopened run is just a
 * terminal block that replays the log.
 *
 * Persistence asymmetry (a run marker carries only sessionId + idea): if the server LOST the
 * session, GET /sessions/:id 404s — the block shows the same honest "session gone → start a new
 * build" recovery card the studio used, not a blank/frozen block.
 */
function RunBlockInner({
  sessionId, idea, terminal = false, api, onApprove, onConfirm, onNewBuild,
  baseUrl = '', makeClient, onView, active = false, busy = false, onReactivate, onActionError,
}: {
  sessionId: string
  idea: string
  /** Re-activate THIS run (make it the studio's live, streaming active run) — called before a
   *  recovery/gate action on a NON-active block so its result streams in instead of silently
   *  no-op'ing on a frozen, one-shot-folded block. */
  onReactivate?: (id: string) => void
  /** Surface a recovery/gate action failure to the studio's error banner (drive() used to swallow
   *  every failure, leaving a stuck action with no feedback). 409s (a gate refusal) stay quiet. */
  onActionError?: (msg: string) => void
  /** True for an older/reopened run: fold the /log once then close (only the active run streams). */
  terminal?: boolean
  api: ApiClient
  /** GATE-SAFE: bare callbacks to the existing gated routes (mint nothing client-side). */
  onApprove: () => void
  onConfirm: () => void
  /** In-flight guard: while a gate action (approve/confirm/proceed) is mid-POST, the inline gate
   *  cards disable so a double-click can't fire it twice (matches the pre-unification studio). */
  busy?: boolean
  /** Honest recovery for a 404'd (genuinely gone) session — reuses the studio's "new build" reset. */
  onNewBuild: () => void
  baseUrl?: string
  makeClient?: () => EventStreamClient
  /** The ACTIVE run reports its folded view UP so the studio's right rail (preview/trust/publish)
   *  and header roster track it — exactly ONE reporter (the active run), so no setState storm. */
  onView?: (view: SessionView) => void
  /** Whether this run is the active (latest, in-flight or just-reopened) one. Only the active run
   *  reports its view up; terminal/older runs render statically without driving the studio. */
  active?: boolean
}) {
  const { t } = useI18n()
  const live = useLiveChat(sessionId, idea, api, baseUrl, makeClient, terminal)

  // RECOVERY driving for the inline RecoveryBubble (the action surface that used to live on the
  // retired pipeline strip). GATE-SAFE: these POST to the owner-scoped recovery routes — the server
  // re-runs REAL verification and never bypasses a structural gate. `recovering` guards a double-fire.
  const [recovering, setRecovering] = useState(false)
  const drive = (fn: (id: string) => Promise<unknown>) => (): void => {
    if (recovering) return
    // Re-activate a NON-active run BEFORE firing, so its result streams in live (a terminal block
    // folds /log once + never reconnects — the action would otherwise fire with no visible outcome).
    if (!active) onReactivate?.(sessionId)
    setRecovering(true)
    void Promise.resolve(fn(sessionId))
      // Surface a real failure (the SSE stream reflects a SUCCESS, but a rejected POST had no
      // feedback). A 409 is an expected gate/precondition refusal → stay quiet, like the studio.
      .catch((e: unknown) => { if (!(ApiError.is(e) && e.status === 409)) onActionError?.(actionErrorText(e, t)) })
      .finally(() => setRecovering(false))
  }
  const onProceed = drive(id => api.resolveCritic(id, 'proceed'))
  const onAbandon = drive(id => api.resolveCritic(id, 'abandon'))
  const onRetry = drive(id => api.retryRun(id))
  // push_failed RETRY must confirm THIS run's session (not the studio's active-run confirm) — a
  // non-active run's retry would otherwise push the wrong session. Bound to sessionId via drive().
  const onConfirmRecovery = drive(id => api.confirm(id))
  const acting = busy || recovering

  // Per-run stale-session detection: a run marker persists only sessionId+idea, so on reload the
  // server may have lost the session (restart wiped the in-memory store / external deletion) →
  // GET /sessions/:id 404s. ONLY a 404 flags it (transient network/500 stays silent), mirroring
  // the studio's honest recovery. The active run re-probes when its live stream gives up.
  const [sessionGone, setSessionGone] = useState(false)
  useEffect(() => {
    let cancelled = false
    void api.getSession(sessionId)
      .then(() => { if (!cancelled) setSessionGone(false) })
      .catch(e => { if (!cancelled && ApiError.is(e) && e.status === 404) setSessionGone(true) })
    return () => { cancelled = true }
  }, [sessionId, api, live.view.connectionGone])

  // Only the ACTIVE run reports its view up (the rail/header follow the active run). A terminal
  // block stays static and never drives the studio. Report on every view change (the same
  // per-frame cadence as the old single subscription — one setState per frame, no storm).
  const onViewRef = useRef(onView)
  onViewRef.current = onView
  useEffect(() => { if (active) onViewRef.current?.(live.view) }, [active, live.view])

  if (sessionGone) {
    return (
      <section role="alert" className="ml-11 rounded-2xl border border-amber-400/25 bg-amber-400/[0.06] p-3 text-sm text-slate-200 shadow-[0_0_30px_rgba(251,191,36,0.1)]">
        <div className="flex flex-col gap-2">
          <div className="font-semibold text-slate-100">{t('session.gone.hint')}</div>
          <button
            onClick={onNewBuild}
            className="w-fit rounded-md bg-gradient-to-r from-amber-400 to-[#07D1AF] px-3 py-1.5 text-sm font-semibold text-slate-900 shadow-[0_0_14px_rgba(251,191,36,0.3)] hover:shadow-[0_0_16px_rgba(251,191,36,0.4)] disabled:opacity-40"
          >
            {t('session.gone.action')}
          </button>
        </div>
      </section>
    )
  }

  const title = ideaTitle(idea)

  return (
    <section className="border-t border-white/5 pt-3">
      {/* The build's title (first line of the idea/spec) so a REOPENED run shows WHAT it is. */}
      {title && (
        <div className="mb-2 truncate text-sm font-semibold text-slate-100" title={idea}>{title}</div>
      )}
      {/* COMPACT pipeline-strip HEADER: RunPipeline verbatim (TrustLedger + spec/push gates +
          critic/verify/push recovery + Stop), so all the load-bearing gate/recovery wiring stays
          where it has been live-verified. Gates call the same bare onApprove/onConfirm (server-minted). */}
      {/* SLIM run header: trust headline + ledger + Stop + transport banners only. The per-stage
          status + gate/recovery ACTIONS are inline bubbles below (the "sade sohbet" redesign). */}
      <RunPipeline
        view={live.view}
        api={api}
        sessionGone={sessionGone}
        compact
      />
      {/* The chronological agent work, INLINE below the header: the latent (already-tested) bubble
          renderer made live — agent turns, gate/verify/code-review/preview/error/done cards, with
          orchestrator English narration suppressed (ChatThread's NarrationBubble returns null). The
          gate bubbles' buttons reuse the SAME bare onApprove/onConfirm — no client-side mint. */}
      {live.messages.length > 0 && (
        <div className="mt-3 flex flex-col gap-4">
          {live.messages.map(m => (
            <ChatBubble key={m.id} m={m} onApprove={onApprove} onConfirm={onConfirm} onConfirmRecovery={onConfirmRecovery}
              onProceed={onProceed} onAbandon={onAbandon} onRetry={onRetry} busy={acting} />
          ))}
        </div>
      )}
    </section>
  )
}

/**
 * PERF (chat-spine cascade): a run-block mounts its OWN useLiveChat, so it re-renders on its own SSE
 * frames REGARDLESS of memo. The ACTIVE run reports its folded view UP every frame → ChatStudio
 * setActiveView → the whole spine (AkisChat) re-renders → without memo, EVERY terminal RunBlock would
 * re-render too (it received fresh inline prop identities). React.memo lets each terminal block BAIL on
 * that parent cascade because all its props are now reference-stable (sessionId/idea/terminal/api/baseUrl
 * are stable; the callbacks are stabilized at the call site — AkisChat's shared `noop` + ChatStudio's
 * useCallback'd handlers). The active run still streams live: its internal useLiveChat state changes are
 * NOT props, so memo never gates them — memo only blocks the redundant PARENT re-render of terminal
 * siblings. `active`/`busy` legitimately change identity-free (booleans) and flip a block in/out of live.
 */
export const RunBlock = memo(RunBlockInner)
