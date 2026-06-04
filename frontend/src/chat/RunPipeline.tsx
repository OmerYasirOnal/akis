import { useState, type ReactNode } from 'react'
import type { SessionView } from '../live/types.js'
import { useI18n } from '../i18n/I18nContext.js'
import type { StringKey } from '../i18n/catalog.js'
import { agentName } from '../agents/names.js'
import { ApiClient } from '../api/client.js'
import { derivePipeline, summarizePipeline, type PipelineStep, type PipelineStatus, type PipelineStepKey } from './pipeline.js'

const STEP_LABEL: Record<PipelineStepKey, StringKey> = {
  spec: 'pipeline.step.spec',
  build: 'pipeline.step.build',
  review: 'pipeline.step.review',
  verify: 'pipeline.step.verify',
  ship: 'pipeline.step.ship',
}
const STEP_NO: Record<PipelineStepKey, string> = { spec: '①', build: '②', review: '③', verify: '④', ship: '⑤' }

/** The TRUST ROLE each step plays — what makes AKIS legibly trustworthy rather than just fast.
 *  Surfacing producer↔verifier SEPARATION (Builder vs Independent verifier) and the human gates
 *  is the differentiator vs a generic prompt-to-app clone (capability-token gates, not undo buttons). */
const TRUST_ROLE: Record<PipelineStepKey, StringKey> = {
  spec: 'trust.role.spec',
  build: 'trust.role.builder',
  review: 'trust.role.critic',
  verify: 'trust.role.verifier',
  ship: 'trust.role.deploy',
}
/** Distinct tints so the producer (Builder, violet) and the INDEPENDENT verifier (emerald) read as
 *  different actors at a glance — the human gates are teal. */
const TRUST_TINT: Record<PipelineStepKey, string> = {
  spec: 'text-[#07D1AF]/80',
  build: 'text-violet-300/80',
  review: 'text-amber-300/70',
  verify: 'text-emerald-300/90',
  ship: 'text-[#07D1AF]/80',
}

/** Translate a derivePipeline `stat` token into a localized fragment. Falls back to the raw
 *  token (e.g. a provider name like "anthropic") which has no catalogue key. */
function statText(t: (k: StringKey) => string, stat: string | undefined): string | undefined {
  if (!stat) return undefined
  const m = stat.match(/^(\d+) findings$/)
  if (m) return `${m[1]} ${t('pipeline.stat.findings')}`
  const tm = stat.match(/^(\d+) tests$/)
  if (tm) return `${tm[1]} ${t('pipeline.stat.tests')}`
  const KEYS: Record<string, StringKey> = {
    'spec ready': 'pipeline.stat.specReady', 'spec approved': 'pipeline.stat.specApproved',
    'spec rejected': 'pipeline.stat.specRejected', 'spec failed': 'pipeline.stat.specFailed',
    'critic rejected': 'pipeline.stat.criticRejected',
    'writing code': 'pipeline.stat.writingCode', 'code written': 'pipeline.stat.codeWritten',
    'build failed': 'pipeline.stat.buildFailed', 'reviewing': 'pipeline.stat.reviewing',
    'review clean': 'pipeline.stat.reviewClean', 'critical finding': 'pipeline.stat.criticalFinding',
    'critical proceeded': 'pipeline.stat.criticalProceeded',
    'running tests': 'pipeline.stat.runningTests', 'verify failed': 'pipeline.stat.verifyFailed',
    'ready to ship': 'pipeline.stat.readyToShip', 'finishing': 'pipeline.stat.finishing',
    'shipped': 'pipeline.stat.shipped', 'run failed': 'pipeline.stat.runFailed',
    'push failed': 'pipeline.stat.pushFailed', 'run cancelled': 'pipeline.stat.runCancelled',
  }
  const key = KEYS[stat]
  return key ? t(key) : stat
}

/** Per-status visual tokens — the node ring + a small dot, in the cosmic palette. */
const NODE: Record<PipelineStatus, { ring: string; dot: string; num: string }> = {
  pending: { ring: 'border-white/10 bg-white/[0.02]', dot: 'bg-slate-600', num: 'text-slate-500' },
  active: { ring: 'border-[#07D1AF]/50 bg-[#07D1AF]/[0.07] shadow-[0_0_22px_rgba(7,209,175,0.22)]', dot: 'bg-[#07D1AF] animate-pulse shadow-[0_0_8px_2px_rgba(7,209,175,0.6)]', num: 'text-[#07D1AF]' },
  done: { ring: 'border-emerald-400/30 bg-emerald-400/[0.06]', dot: 'bg-emerald-400', num: 'text-emerald-300' },
  awaiting: { ring: 'border-amber-400/50 bg-amber-400/[0.08] shadow-[0_0_22px_rgba(251,191,36,0.18)]', dot: 'bg-amber-300 animate-pulse', num: 'text-amber-300' },
  failed: { ring: 'border-rose-400/40 bg-rose-400/[0.07]', dot: 'bg-rose-400', num: 'text-rose-300' },
  // CAUTION = proceeded past a critical finding: amber like 'awaiting' but a STATIC dot (no pulse)
  // — it's a settled, non-blocking warning on a build that already shipped, not a pending action.
  caution: { ring: 'border-amber-400/40 bg-amber-400/[0.07]', dot: 'bg-amber-300', num: 'text-amber-300' },
}

function StepNode({ step, t, onApprove, onConfirm, onProceed, onAbandon, onRetry, busy }: {
  step: PipelineStep; t: (k: StringKey) => string
  onApprove: () => void; onConfirm: () => void
  onProceed: () => void; onAbandon: () => void; onRetry: () => void
  busy?: boolean
}) {
  const v = NODE[step.status]
  const stat = statText(t, step.stat)
  return (
    <div className={`relative flex min-w-0 flex-1 flex-col gap-1.5 rounded-xl border px-3 py-2.5 transition ${v.ring}`}>
      <div className="flex items-center gap-2">
        <span className={`text-sm font-black tabular-nums ${v.num}`}>{STEP_NO[step.key]}</span>
        <span className="truncate text-xs font-semibold text-slate-100">{t(STEP_LABEL[step.key])}</span>
        <span className={`ml-auto h-1.5 w-1.5 shrink-0 rounded-full ${v.dot}`} title={t(`pipeline.status.${step.status}`)} />
      </div>
      <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
        <span className="text-[10px] font-medium uppercase tracking-wide text-slate-400">{agentName(step.role)}</span>
        <span className={`text-[9px] font-semibold uppercase tracking-wide ${TRUST_TINT[step.key]}`}>· {t(TRUST_ROLE[step.key])}</span>
      </div>
      <div className="min-h-[1rem] truncate text-[11px] text-slate-300" title={stat}>{stat ?? t(`pipeline.status.${step.status}`)}</div>
      {/* Deploy is LOCKED until verification passes — make that gate visible, not just an absent
          button: a user/investor should SEE that ship can't happen before the verifier mints. */}
      {step.key === 'ship' && step.status === 'pending' && (
        <div className="text-[10px] text-slate-500"><span aria-hidden>🔒</span> {t('trust.deploy.locked')}</div>
      )}
      {/* The generic gate action (approve / confirm). Suppressed when a push_failed recovery is
          showing, which renders its OWN labeled "retry" button below (also wired to onConfirm) —
          so there's never a duplicate Confirm. */}
      {step.action && step.recovery !== 'push_failed' && (
        <button
          onClick={step.action === 'approve' ? onApprove : onConfirm}
          disabled={busy}
          className="mt-1 rounded-md bg-gradient-to-r from-[#07D1AF] to-violet-500 px-2 py-1 text-[11px] font-semibold text-slate-900 shadow-[0_0_14px_rgba(7,209,175,0.35)] disabled:opacity-40"
        >
          {t(step.action === 'approve' ? 'chat.approve' : 'chat.confirm')}
        </button>
      )}
      {/* Recovery actions: a parked run is actionable here, not a silent amber dot. These are
          NOT structural gates — proceed/retry never bypass verify/push (server-enforced). */}
      {step.recovery === 'critic_resolution' && (
        <div className="mt-1 flex flex-wrap gap-1.5">
          <button onClick={onProceed} disabled={busy}
            className="rounded-md bg-gradient-to-r from-[#07D1AF] to-violet-500 px-2 py-1 text-[11px] font-semibold text-slate-900 shadow-[0_0_14px_rgba(7,209,175,0.35)] disabled:opacity-40">
            {t('recovery.critic.proceed')}
          </button>
          <button onClick={onAbandon} disabled={busy}
            className="rounded-md border border-rose-400/40 px-2 py-1 text-[11px] font-semibold text-rose-200 hover:bg-rose-400/10 disabled:opacity-40">
            {t('recovery.critic.abandon')}
          </button>
        </div>
      )}
      {step.recovery === 'verify_failed' && (
        <button onClick={onRetry} disabled={busy}
          className="mt-1 rounded-md bg-gradient-to-r from-amber-400 to-[#07D1AF] px-2 py-1 text-[11px] font-semibold text-slate-900 shadow-[0_0_14px_rgba(251,191,36,0.3)] disabled:opacity-40">
          {t('recovery.verify.retry')}
        </button>
      )}
      {/* push_failed: a labeled retry wired to onConfirm → the GATED confirmPush (Gate 4 intact). */}
      {step.recovery === 'push_failed' && (
        <button onClick={onConfirm} disabled={busy}
          className="mt-1 rounded-md bg-gradient-to-r from-amber-400 to-[#07D1AF] px-2 py-1 text-[11px] font-semibold text-slate-900 shadow-[0_0_14px_rgba(251,191,36,0.3)] disabled:opacity-40">
          {t('recovery.push.retry')}
        </button>
      )}
    </div>
  )
}

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

/**
 * The compact, scannable run pipeline that headlines the redesigned run view. Renders the
 * 5 fixed AKIS stages (Spec → Build → Review → Verify → Ship) derived purely from the
 * SessionView, a one-line summary once there's something to summarise, and surfaces the
 * spec-approval / push-confirm gate buttons IN-LINE on their step when a gate is awaiting —
 * wired to the same onApprove/onConfirm the verbose thread uses. The verbose chronological
 * log lives below this in a collapsed <details> (rendered by ChatStudio).
 */
export function RunPipeline({ view, onApprove, onConfirm, busy, details, api }: {
  view: SessionView
  onApprove: () => void
  onConfirm: () => void
  busy?: boolean
  /** The collapsed raw-log slot (the existing ChatThread), rendered inside <details>. */
  details?: ReactNode
  /** REST client used to drive the recovery actions (resolve/retry). Same-origin default
   *  (prod). A caller can inject a baseUrl-bound client; tests inject a fake. */
  api?: ApiClient
}) {
  const { t } = useI18n()
  const steps = derivePipeline(view)
  const summary = summarizePipeline(view)
  // Self-contained recovery driving (no ChatStudio change needed): the run is parked in a
  // recoverable state; these POST to the owner-scoped recovery endpoints, which NEVER bypass
  // a structural gate (the server re-runs real verification; spec/push gates still apply).
  const client = api ?? new ApiClient()
  const [recovering, setRecovering] = useState(false)
  // The activity log defaults OPEN while a run is in-flight (so you WATCH each agent work,
  // not hunt for a collapsed "raw log"), and the user can still collapse/expand it — once
  // set, their choice sticks (`undefined` = follow the run's in-flight state).
  const [logOpen, setLogOpen] = useState<boolean | undefined>(undefined)
  const drive = (fn: (id: string) => Promise<unknown>) => (): void => {
    const id = view.sessionId
    if (!id || recovering) return
    setRecovering(true)
    void Promise.resolve(fn(id)).catch(() => { /* the SSE stream reflects the outcome; banner clears on next event */ }).finally(() => setRecovering(false))
  }
  const onProceed = drive(id => client.resolveCritic(id, 'proceed'))
  const onAbandon = drive(id => client.resolveCritic(id, 'abandon'))
  const onRetry = drive(id => client.retryRun(id))
  // Run control: STOP/CANCEL an in-flight run — a clean TERMINAL abandon. NOT a gate bypass:
  // the server only sets `cancelled` (it never verifies/ships); a 409 from a terminal run is
  // swallowed (the next event reflects the real state).
  const onCancel = drive(id => client.cancelRun(id))
  const acting = busy || recovering
  // The Stop control is shown only while the run is NON-terminal (in-flight or parked) — once
  // done/failed/cancelled there is nothing to stop.
  const inFlight = !!view.sessionId && (view.status === 'running' || view.status === 'started')
  // The relevant recovery hint (one at a time — a run is in at most one parked state).
  const recoveryHint: StringKey | undefined = steps.some(s => s.recovery === 'critic_resolution')
    ? 'recovery.critic.hint'
    : steps.some(s => s.recovery === 'verify_failed')
      ? 'recovery.verify.hint'
      : steps.some(s => s.recovery === 'push_failed')
        ? 'recovery.push.hint'
        : undefined

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">{t('pipeline.title')}</div>
        {/* Stop/Cancel: a clean terminal ABANDON of an in-flight run — never a gate bypass. */}
        {inFlight && (
          <button onClick={onCancel} disabled={recovering} aria-label={t('run.stop')}
            className="shrink-0 rounded-md border border-rose-400/40 px-2 py-0.5 text-[11px] font-semibold text-rose-200 transition hover:bg-rose-400/10 disabled:opacity-40">
            {t('run.stop')}
          </button>
        )}
      </div>

      {/* The trust headline — states the structural moat in one line so it's legible at a glance:
          these are guarantees enforced by construction (gates + producer/verifier seam), not copy.
          HONESTY: in a demo run the structural gates are STILL real, but the test RESULTS are
          simulated — say so right here, co-located with the trust copy, so "verified" can't mislead. */}
      <div className="rounded-lg border border-[#07D1AF]/15 bg-[#07D1AF]/[0.04] px-3 py-1.5 text-[10.5px] leading-snug text-slate-400">
        <span className="text-[#07D1AF]/80" aria-hidden>🛡</span> {t('trust.headline')}
        {view.tests.demo && (
          <div className="mt-1 text-amber-300/80"><span aria-hidden>⚠</span> {t('trust.headline.demo')}</div>
        )}
      </div>

      {/* The trust ledger: which structural tokens have actually cleared this run (proof, not copy). */}
      <TrustLedger view={view} t={t} />

      {/* SSE dropped: a subtle, NON-terminal "reconnecting" banner (distinct from a failed run)
          so the live view stops pulsing forever; the resumable stream re-syncs via Last-Event-ID. */}
      {view.connectionLost && (
        <div role="status" className="flex items-center gap-2 rounded-xl border border-amber-400/20 bg-amber-400/[0.05] px-3 py-1.5 text-[11px] text-amber-200/90">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-300" aria-hidden />
          {t('live.reconnecting')}
        </div>
      )}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
        {steps.map((s, i) => (
          <div key={s.key} className="flex min-w-0 flex-1 items-center gap-2">
            <StepNode step={s} t={t} onApprove={onApprove} onConfirm={onConfirm} onProceed={onProceed} onAbandon={onAbandon} onRetry={onRetry} {...(acting !== undefined ? { busy: acting } : {})} />
            {i < steps.length - 1 && <span aria-hidden className="hidden shrink-0 text-slate-600 sm:inline">→</span>}
          </div>
        ))}
      </div>

      {recoveryHint && (
        <div role="status" className="rounded-xl border border-amber-400/30 bg-amber-400/[0.06] px-3 py-2 text-xs text-amber-200">
          {t(recoveryHint)}
        </div>
      )}

      {summary && (
        <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-sm font-medium text-slate-200">
          {summary
            .replace('✓ Verified', `✓ ${t('pipeline.summary.verified')}`)
            .replace('✗ Not verified', `✗ ${t('pipeline.summary.notVerified')}`)
            .replace('✗ Run failed', `✗ ${t('pipeline.summary.runFailed')}`)
            .replace('critical finding', t('pipeline.stat.criticalFinding'))
            .replace('review clean', t('pipeline.summary.reviewClean'))
            .replace('shipped', t('pipeline.summary.shipped'))
            .replace(/(\d+) tests/, `$1 ${t('pipeline.stat.tests')}`)
            .replace(/(\d+) findings/, `$1 ${t('pipeline.stat.findings')}`)}
        </div>
      )}

      {details && (
        <details open={logOpen ?? inFlight} onToggle={e => setLogOpen((e.currentTarget as HTMLDetailsElement).open)}
          className="group rounded-xl border border-white/10 bg-white/[0.02]">
          <summary className="flex cursor-pointer select-none list-none items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-400 transition hover:text-slate-200">
            <span className="inline-block transition group-open:rotate-90" aria-hidden>▸</span>
            {inFlight && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#07D1AF]" aria-hidden />}
            {t('pipeline.details')}
          </summary>
          <div className="border-t border-white/10 px-3 py-3">{details}</div>
        </details>
      )}
    </div>
  )
}
