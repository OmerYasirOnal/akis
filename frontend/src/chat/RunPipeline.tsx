import { useState, memo } from 'react'
import type { SessionView } from '../live/types.js'
import { useI18n } from '../i18n/I18nContext.js'
import type { StringKey } from '../i18n/catalog.js'
import { ApiClient } from '../api/client.js'

/**
 * The SLIM run HEADER (formerly the 5-stage pipeline strip). The "sade sohbet" redesign moved the
 * per-stage status + the gate/recovery ACTIONS into the inline conversation bubbles (the run reads
 * as ONE conversation, not a dashboard stacked on a chat). What stays here is the lightweight TRUST
 * spine that the bubbles can't carry at a glance:
 *   - the trust HEADLINE (producer↔verifier separation; deploy needs approval; every step auditable),
 *   - the TRUST LEDGER (the three structural tokens — ApprovedSpec / VerifyToken / ApprovedPush — as
 *     proof, not copy),
 *   - the transport banners (reconnecting / connection-gone),
 *   - the Stop control for an in-flight run.
 * No StepNodes, no gate/recovery buttons here anymore — those are GateBubble/RecoveryBubble inline.
 */

/**
 * The TRUST LEDGER — the three structural token states turned into visible PROOF, not copy:
 * ApprovedSpec, the fail-closed VerifyToken, and ApprovedPush. Derived purely from the view, so
 * it is an honest attestation of which structural gates have actually cleared THIS run (and, in a
 * demo run, that the VerifyToken stands on a simulated result). This is the moat, made legible.
 */
function TrustLedger({ view, t }: { view: SessionView; t: (k: StringKey) => string }) {
  // PROOF, NOT COPY: each token state is read from the SAME structural signal the backend gates on,
  // never inferred. VerifyToken mirrors the fail-closed mint rule exactly (≥1-test pass) rather than
  // trusting a backend invariant; deploy reflects the ApprovedPush gate ONLY (no status fallback that
  // could claim "approved" without the gate event). Spec approval is a real human action even in a
  // demo run, so it is never marked simulated — only the test RESULT behind VerifyToken is.
  const specOk = view.gates.specApproval?.state === 'satisfied'
  const verifyOk = view.tests.ran && view.tests.passed && view.tests.testsRun >= 1
  const deployOk = view.gates.pushConfirm?.state === 'satisfied'
  const items: { key: string; label: StringKey; ok: boolean; simulated: boolean }[] = [
    { key: 'spec', label: 'trust.ledger.spec', ok: specOk, simulated: false },
    { key: 'verify', label: 'trust.ledger.verify', ok: verifyOk, simulated: verifyOk && !!view.tests.demo },
    { key: 'deploy', label: 'trust.ledger.deploy', ok: deployOk, simulated: false },
  ]
  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label={t('trust.ledger.title')}>
      <span className="text-[9px] font-semibold uppercase tracking-[0.18em] text-slate-500">{t('trust.ledger.title')}</span>
      {items.map(it => (
        <span key={it.key}
          aria-label={`${t(it.label)} — ${it.ok ? t('trust.ledger.cleared') : t('trust.ledger.pending')}${it.simulated ? ', ' + t('trust.ledger.simulated') : ''}`}
          className={`rounded-md border px-2 py-0.5 text-[10px] font-medium ${it.ok ? 'border-emerald-400/30 bg-emerald-400/[0.07] text-emerald-200' : 'border-white/10 bg-white/[0.02] text-slate-500'}`}>
          <span aria-hidden>{it.ok ? '✓' : '◻'}</span> {t(it.label)}
          {it.simulated
            ? <span className="text-amber-300/80"> · {t('trust.ledger.simulated')}</span>
            : it.ok ? null : <span className="opacity-70"> · {t('trust.ledger.pending')}</span>}
        </span>
      ))}
    </div>
  )
}

export const RunPipeline = memo(function RunPipeline({ view, api, sessionGone = false, compact = false }: {
  view: SessionView
  /** REST client used to drive Stop/cancel. Same-origin default (prod); tests inject a fake. */
  api?: ApiClient
  /** True when GET /sessions/:id returned 404 — the session is genuinely GONE (not a transient
   *  transport drop). The studio shows the honest "Start new build" card above, so the transport
   *  banners below are suppressed: a deleted session's SSE 404 is not a reconnect story. */
  sessionGone?: boolean
  /** Tighter spacing for the per-run-block header use. */
  compact?: boolean
}) {
  const { t } = useI18n()
  const client = api ?? new ApiClient()
  const [cancelling, setCancelling] = useState(false)
  // Stop/Cancel an in-flight run — a clean TERMINAL abandon. NOT a gate bypass: the server only
  // sets `cancelled` (it never verifies/ships); a 409 from a terminal run is swallowed.
  const onCancel = (): void => {
    const id = view.sessionId
    if (!id || cancelling) return
    setCancelling(true)
    void Promise.resolve(client.cancelRun(id)).catch(() => { /* the SSE stream reflects the outcome */ }).finally(() => setCancelling(false))
  }
  // F2 — a run PARKED awaiting a human recovery (push_failed / verify_failed / a stuck critic) is
  // signaled ONLY by a `recovery` event, so view.status stays 'running' even though the run is no
  // longer in-flight. CANCEL_IMMUNE now 409s a cancel of push_failed/verify_failed, so a Stop here
  // would be a silent no-op (a dead button); the inline RecoveryBubble is the actionable surface.
  // Treat an AWAITING recovery as NOT in-flight → hide Stop. (A critic park IS cancellable server-
  // side, but its actionable surface is the proceed/abandon RecoveryBubble — a parallel Stop is
  // redundant and confusing, so it's hidden here too.)
  const awaitingRecovery =
    view.pushFailed?.retry === 'awaiting' ||
    view.verifyFailed?.retry === 'awaiting' ||
    view.recovery?.critic === 'awaiting'
  // Stop is shown only while the run is NON-terminal (in-flight) AND not parked — once done/failed/
  // cancelled or parked-for-recovery there is nothing (live) to stop.
  const inFlight = !!view.sessionId && (view.status === 'running' || view.status === 'started') && !awaitingRecovery

  return (
    <div className={`flex flex-col ${compact ? 'gap-2' : 'gap-3'}`}>
      {/* The trust headline doubles as the section opener; Stop rides on its right edge. */}
      <div className="flex items-start gap-2">
        <div className="flex-1 rounded-lg border border-[#07D1AF]/15 bg-[#07D1AF]/[0.04] px-3 py-1.5 text-[10.5px] leading-snug text-slate-400">
          <span className="text-[#07D1AF]/80" aria-hidden>🛡</span> {t('trust.headline')}
          {view.tests.demo && (
            <div className="mt-1 text-amber-300/80"><span aria-hidden>⚠</span> {t('trust.headline.demo')}</div>
          )}
        </div>
        {inFlight && (
          <button onClick={onCancel} disabled={cancelling} aria-label={t('run.stop')}
            className="shrink-0 rounded-md border border-rose-400/40 px-2 py-0.5 text-[11px] font-semibold text-rose-200 transition hover:bg-rose-400/10 disabled:opacity-40">
            {t('run.stop')}
          </button>
        )}
      </div>

      {/* The trust ledger: which structural tokens have actually cleared this run (proof, not copy). */}
      <TrustLedger view={view} t={t} />

      {/* TERMINAL transport state: reconnects exhausted — honest "stopped + Reload". SUPPRESSED when
          the session is genuinely GONE (getSession 404): the honest recovery is the gone-card's
          "Start new build" above, not a "Reload" that would just hit the same 404. */}
      {view.connectionGone && !sessionGone ? (
        <div role="alert" className="flex items-center gap-2 rounded-xl border border-rose-400/25 bg-rose-400/[0.06] px-3 py-1.5 text-[11px] text-rose-200/90">
          <span className="h-1.5 w-1.5 rounded-full bg-rose-300" aria-hidden />
          {t('live.connectionGone')}
          <button onClick={() => window.location.reload()} className="ml-auto shrink-0 rounded border border-rose-300/30 px-2 py-0.5 text-[11px] text-rose-100 hover:bg-rose-400/10">{t('live.reload')}</button>
        </div>
      ) : view.connectionLost && !sessionGone && (
        /* SSE dropped: a subtle, NON-terminal "reconnecting" banner; the resumable stream re-syncs. */
        <div role="status" className="flex items-center gap-2 rounded-xl border border-amber-400/20 bg-amber-400/[0.05] px-3 py-1.5 text-[11px] text-amber-200/90">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-300" aria-hidden />
          {t('live.reconnecting')}
        </div>
      )}
    </div>
  )
})
