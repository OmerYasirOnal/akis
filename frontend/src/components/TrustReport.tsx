import type { TestEvidence, ScenarioEvidence } from '@akis/shared'
import type { CodeReviewState } from '../live/types.js'
import { useI18n } from '../i18n/I18nContext.js'
import type { StringKey } from '../i18n/catalog.js'

type T = (k: StringKey) => string

/**
 * Read-only TRUST REPORT — turns the bare "N tests" integer into the auditable evidence
 * behind the green checkmark. It surfaces the STRUCTURED detail PR #75 persisted on
 * `SessionState.testEvidence` (named scenarios + per-scenario structured failure
 * reason/step, counts, summed durationMs) plus the critic's read-only verdict from
 * `view.codeReview`. Pure projection of already-fetched data — NO backend/gate change.
 *
 * NO-XSS: every agent-influenced string (scenario name, structured failure reason, failing
 * step, top-level failure reason) is rendered as plain TEXT children — React auto-escapes
 * them — never dangerouslySetInnerHTML. A `<script>` in a reason shows as literal text, never
 * an injected/executed node. The evidence is structured-only by construction (PR #75), but we
 * still treat it as untrusted at the render boundary.
 *
 * A DEMO (mock-runner / simulated) verification is flagged PROMINENTLY at the top, so a
 * trust report on a demo run can never be mistaken for one backed by real tests.
 */
export function TrustReport({ evidence, codeReview, demo }: {
  evidence?: TestEvidence | undefined
  codeReview?: CodeReviewState | undefined
  demo?: boolean | undefined
}) {
  const { t } = useI18n()

  // Counts: prefer the structured failure count when present; otherwise derive from scenarios.
  const total = evidence?.testsRun ?? 0
  const failedCount = evidence
    ? (evidence.failure?.failedCount ?? evidence.scenarios.filter(s => !s.passed).length)
    : 0
  const passedCount = Math.max(0, total - failedCount)

  const stat = (label: string, value: string, tone = 'text-slate-100') => (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
      <div className="text-[10px] uppercase tracking-widest text-slate-400">{label}</div>
      <div className={`text-lg font-semibold ${tone}`}>{value}</div>
    </div>
  )

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-200">{t('trust.title')}</h3>
        {/* A simulated (mock-runner) verification is flagged PROMINENTLY — a Trust Report on a
            demo run must say so, so a demo "✓" can never read as a real ≥1-test pass. */}
        {demo && (
          <span role="status" title={t('result.demo.title')}
            className="inline-flex items-center gap-1 rounded-md border border-amber-400/40 bg-amber-400/15 px-2 py-0.5 text-[11px] font-semibold text-amber-200">
            <span aria-hidden>⚠</span>{t('result.demo.badge')}
          </span>
        )}
      </div>

      {!evidence ? (
        <div className="flex flex-1 items-center justify-center rounded-xl border border-white/10 bg-black/40 p-4 text-center">
          <span className="text-sm text-slate-500">{t('trust.empty')}</span>
        </div>
      ) : (
        <>
          <p className="text-[11px] text-slate-500">{t('trust.subtitle')}</p>

          {/* Counts + duration */}
          <div className="grid grid-cols-4 gap-2">
            {stat(t('trust.tests'), String(total), 'text-[#07D1AF]')}
            {stat(t('trust.passed'), String(passedCount), 'text-emerald-300')}
            {stat(t('trust.failed'), String(failedCount), failedCount > 0 ? 'text-rose-300' : 'text-slate-300')}
            {stat(t('trust.duration'), `${evidence.durationMs}ms`)}
          </div>

          {/* Critic verdict (read-only status card) */}
          {codeReview && <CriticVerdict review={codeReview} t={t} />}

          {/* Top-level failure reason (timeout / all-skipped / zero-tests — no per-scenario fail) */}
          {evidence.failure?.reason && (
            <div className="rounded-lg border border-rose-500/30 bg-rose-500/[0.07] px-3 py-2">
              <div className="text-[10px] uppercase tracking-widest text-rose-300/80">{t('trust.failure.title')}</div>
              {/* TEXT child → React-escaped; a <script> reason renders literally, never executes. */}
              <div className="mt-0.5 text-sm text-rose-200">{evidence.failure.reason}</div>
            </div>
          )}

          {/* Named scenarios (bdd + e2e) with pass/fail + structured failure reason/step */}
          {evidence.scenarios.length > 0 && (
            <div className="flex min-h-0 flex-col gap-1.5">
              <div className="text-[10px] uppercase tracking-widest text-slate-400">{t('trust.scenarios')}</div>
              <ul className="flex flex-col gap-1.5" aria-label={t('trust.scenarios')}>
                {evidence.scenarios.map((s, i) => (
                  <ScenarioRow key={`${s.suite}:${s.name}:${i}`} s={s} t={t} />
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** One scenario row. The name / reason / step are agent-influenced → rendered as TEXT (escaped). */
function ScenarioRow({ s, t }: { s: ScenarioEvidence; t: T }) {
  return (
    <li className={`rounded-lg border px-3 py-2 ${s.passed ? 'border-white/10 bg-white/[0.02]' : 'border-rose-500/30 bg-rose-500/[0.06]'}`}>
      <div className="flex items-start gap-2">
        <span aria-hidden className={`mt-0.5 shrink-0 text-sm ${s.passed ? 'text-emerald-400' : 'text-rose-400'}`}>
          {s.passed ? '✓' : '✕'}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {/* suite tag */}
            <span className="shrink-0 rounded bg-white/[0.06] px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-slate-400">
              {t(s.suite === 'bdd' ? 'trust.suite.bdd' : 'trust.suite.e2e')}
            </span>
            {/* scenario name — TEXT child, React-escaped. */}
            <span className="truncate text-sm text-slate-200" title={s.name}>{s.name}</span>
          </div>
          {!s.passed && (s.reason || s.step) && (
            <div className="mt-1 space-y-0.5 text-xs">
              {s.step && (
                <div className="text-rose-200/80">
                  <span className="text-rose-300/60">{t('trust.failure.step')}: </span>
                  {/* failing step — TEXT child, React-escaped. */}
                  <span className="font-mono">{s.step}</span>
                </div>
              )}
              {s.reason && s.reason !== s.step && (
                /* structured failure reason — TEXT child, React-escaped. */
                <div className="font-mono text-rose-200/80">{s.reason}</div>
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  )
}

/** The critic's read-only verdict (booleans + bounded counts; never free-form prose). */
function CriticVerdict({ review, t }: { review: CodeReviewState; t: T }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
      <div className="text-[10px] uppercase tracking-widest text-slate-400">{t('trust.critic.title')}</div>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
        <span className={`rounded px-2 py-0.5 font-medium ${review.approved ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/20 text-rose-300'}`}>
          {t(review.approved ? 'trust.critic.approved' : 'trust.critic.rejected')}
        </span>
        <span className="text-slate-400">{review.findings} {t('trust.critic.findings')}</span>
        {review.critical && (
          <span className="rounded bg-amber-400/15 px-2 py-0.5 font-medium text-amber-200">{t('trust.critic.critical')}</span>
        )}
        <span className="text-slate-500">{t('trust.critic.iteration')} {review.iteration}</span>
      </div>
    </div>
  )
}
