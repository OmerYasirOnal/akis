import type { ReactNode } from 'react'
import type { SessionView } from '../live/types.js'
import { useI18n } from '../i18n/I18nContext.js'
import type { StringKey } from '../i18n/catalog.js'
import { derivePipeline, summarizePipeline, type PipelineStep, type PipelineStatus, type PipelineStepKey } from './pipeline.js'

const STEP_LABEL: Record<PipelineStepKey, StringKey> = {
  spec: 'pipeline.step.spec',
  build: 'pipeline.step.build',
  review: 'pipeline.step.review',
  verify: 'pipeline.step.verify',
  ship: 'pipeline.step.ship',
}
const AGENT_NAME: Record<string, string> = { orchestrator: 'AKIS', scribe: 'Scribe', proto: 'Proto', trace: 'Trace', critic: 'Critic' }
const STEP_NO: Record<PipelineStepKey, string> = { spec: '①', build: '②', review: '③', verify: '④', ship: '⑤' }

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
    'writing code': 'pipeline.stat.writingCode', 'code written': 'pipeline.stat.codeWritten',
    'build failed': 'pipeline.stat.buildFailed', 'reviewing': 'pipeline.stat.reviewing',
    'review clean': 'pipeline.stat.reviewClean', 'critical finding': 'pipeline.stat.criticalFinding',
    'running tests': 'pipeline.stat.runningTests', 'verify failed': 'pipeline.stat.verifyFailed',
    'ready to ship': 'pipeline.stat.readyToShip', 'finishing': 'pipeline.stat.finishing',
    'shipped': 'pipeline.stat.shipped', 'run failed': 'pipeline.stat.runFailed',
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
}

function StepNode({ step, t, onApprove, onConfirm, busy }: {
  step: PipelineStep; t: (k: StringKey) => string
  onApprove: () => void; onConfirm: () => void; busy?: boolean
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
      <div className="flex items-baseline gap-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wide text-slate-400">{AGENT_NAME[step.role] ?? step.role}</span>
      </div>
      <div className="min-h-[1rem] truncate text-[11px] text-slate-300" title={stat}>{stat ?? t(`pipeline.status.${step.status}`)}</div>
      {step.action && (
        <button
          onClick={step.action === 'approve' ? onApprove : onConfirm}
          disabled={busy}
          className="mt-1 rounded-md bg-gradient-to-r from-[#07D1AF] to-violet-500 px-2 py-1 text-[11px] font-semibold text-slate-900 shadow-[0_0_14px_rgba(7,209,175,0.35)] disabled:opacity-40"
        >
          {t(step.action === 'approve' ? 'chat.approve' : 'chat.confirm')}
        </button>
      )}
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
export function RunPipeline({ view, onApprove, onConfirm, busy, details }: {
  view: SessionView
  onApprove: () => void
  onConfirm: () => void
  busy?: boolean
  /** The collapsed raw-log slot (the existing ChatThread), rendered inside <details>. */
  details?: ReactNode
}) {
  const { t } = useI18n()
  const steps = derivePipeline(view)
  const summary = summarizePipeline(view)

  return (
    <div className="flex flex-col gap-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">{t('pipeline.title')}</div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
        {steps.map((s, i) => (
          <div key={s.key} className="flex min-w-0 flex-1 items-center gap-2">
            <StepNode step={s} t={t} onApprove={onApprove} onConfirm={onConfirm} {...(busy !== undefined ? { busy } : {})} />
            {i < steps.length - 1 && <span aria-hidden className="hidden shrink-0 text-slate-600 sm:inline">→</span>}
          </div>
        ))}
      </div>

      {summary && (
        <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-sm font-medium text-slate-200">
          {summary
            .replace('✓ Verified', `✓ ${t('pipeline.summary.verified')}`)
            .replace('✗ Not verified', `✗ ${t('pipeline.summary.notVerified')}`)
            .replace('✗ Run failed', `✗ ${t('pipeline.summary.runFailed')}`)
            .replace('review clean', t('pipeline.summary.reviewClean'))
            .replace('shipped', t('pipeline.summary.shipped'))
            .replace(/(\d+) tests/, `$1 ${t('pipeline.stat.tests')}`)
            .replace(/(\d+) findings/, `$1 ${t('pipeline.stat.findings')}`)}
        </div>
      )}

      {details && (
        <details className="group rounded-xl border border-white/10 bg-white/[0.02]">
          <summary className="cursor-pointer select-none list-none px-3 py-2 text-xs font-medium text-slate-400 transition hover:text-slate-200">
            <span className="mr-1 inline-block transition group-open:rotate-90" aria-hidden>▸</span>
            {t('pipeline.details')}
          </summary>
          <div className="border-t border-white/10 px-3 py-3">{details}</div>
        </details>
      )}
    </div>
  )
}
