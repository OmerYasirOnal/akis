import type { ChatMessage, UserMsg, AgentMsg, GateMsg, VerifyMsg, CodeReviewMsg, RecoveryMsg, PreviewMsg, ErrorMsg, DoneMsg } from './chatModel.js'
import { useI18n } from '../i18n/I18nContext.js'
import type { StringKey } from '../i18n/catalog.js'
import { metricsBadge } from './metricsFormat.js'

/** Friendly, localized labels for the raw agent tool names — so the activity reads as clean
 *  steps ("Kod yazılıyor…") instead of dev slugs ("dispatch_proto"). Unknown tools fall back
 *  to their raw name (never blank). Exported so RunBlock can localize tool lines identically. */
export const TOOL_LABEL: Record<string, StringKey> = {
  dispatch_scribe: 'chat.tool.dispatch_scribe',
  dispatch_proto: 'chat.tool.dispatch_proto',
  run_tests: 'chat.tool.run_tests',
  retrieve_knowledge: 'chat.tool.retrieve_knowledge',
  propose_github_write: 'chat.tool.propose_github_write',
}

const ROLE_TINT: Record<string, string> = {
  orchestrator: 'from-teal-400/30 to-teal-400/5 text-teal-200',
  scribe: 'from-sky-400/30 to-sky-400/5 text-sky-200',
  proto: 'from-violet-400/30 to-violet-400/5 text-violet-200',
  trace: 'from-emerald-400/30 to-emerald-400/5 text-emerald-200',
  critic: 'from-amber-400/30 to-amber-400/5 text-amber-200',
}
/** Per-role LEFT-BORDER accent for the agent bubble (the same identity hue as the avatar, drawn
 *  as a solid 2px stripe) so AKIS/Scribe/Proto/Trace/Critic are scannable at a distance — the
 *  monochrome-bubbles fix (M5). A subtle accent, not a full-color card. Unknown roles fall back. */
const ROLE_ACCENT: Record<string, string> = {
  orchestrator: 'border-l-teal-400/50',
  scribe: 'border-l-sky-400/50',
  proto: 'border-l-violet-400/50',
  trace: 'border-l-emerald-400/50',
  critic: 'border-l-amber-400/50',
}
/** A comfortable reading measure (~75ch) so a long agent line never runs edge-to-edge on a wide
 *  window — the owner's "yazı çizgilere taşıyor" fix. Shared by every left-aligned bubble. */
const BUBBLE_MEASURE = 'max-w-[42rem]'
const AKIS_NAME: Record<string, string> = { orchestrator: 'AKIS', scribe: 'Scribe', proto: 'Proto', trace: 'Trace', critic: 'Critic' }
const dot = (ok?: boolean, done?: boolean): string => ok === false ? 'bg-rose-400' : done ? 'bg-emerald-400' : 'bg-teal-400 animate-pulse'

/** The role-tinted agent monogram. Exported so RunBlock renders the same avatar inline. */
export function Avatar({ role }: { role: string }) {
  return <div className={`grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br text-[10px] font-bold ${ROLE_TINT[role] ?? 'from-slate-500/30 to-slate-500/5 text-slate-300'}`}>{(AKIS_NAME[role] ?? role).slice(0, 2)}</div>
}

// ── Per-kind bubble sub-renderers ────────────────────────────────────────────────────────────
// Each renders ONE folded bubble. Exported individually so RunBlock can mount them inline below
// the pipeline-strip header without re-implementing the markup (no strip-vs-bubble duplication).
// They take only the message they render (+ gate handlers for the one interactive card), so they
// stay pure and composable. `narration` is intentionally NOT a renderer — see NarrationBubble.

/** A plain short chat ask. (The long/markdown seed-spec is now an ordinary spine bubble rendered
 *  by AkisChat, not here — this renderer is only the friendly gradient bubble.) */
export function UserBubble({ m }: { m: UserMsg }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[42rem] break-words rounded-2xl rounded-br-sm bg-gradient-to-br from-teal-500/90 to-violet-500/90 px-4 py-3 text-slate-950">{m.text}</div>
    </div>
  )
}

/** Orchestrator narration is free-text (and English), which would break the fully-Turkish, clean
 *  step view — so it is SUPPRESSED. The localized structured cards + the pipeline convey the flow.
 *  Kept as an explicit (always-null) renderer so the suppression decision is documented, not lost. */
export function NarrationBubble(): null {
  return null
}

export function AgentBubble({ m }: { m: AgentMsg }) {
  const { t } = useI18n()
  return (
    <div className="flex items-start gap-3">
      <Avatar role={m.agent} />
      {/* Bounded reading measure + a per-role left-accent stripe (M5/M6): the bubble is no longer a
          flat monochrome box — the role hue on the avatar is echoed as a 2px left border so the
          conversation is scannable, and the ~42rem cap keeps long lines off the right edge. */}
      <div className={`${BUBBLE_MEASURE} rounded-2xl rounded-tl-sm border border-l-2 border-white/10 ${ROLE_ACCENT[m.agent] ?? 'border-l-slate-500/40'} bg-white/[0.03] px-4 py-3`}>
        <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-100">
          <span title={t(`roster.status.${m.ok === false ? 'failed' : m.done ? 'done' : 'working'}`)} className={`h-2 w-2 rounded-full ${dot(m.ok, m.done)}`} />{AKIS_NAME[m.agent] ?? m.agent}
          {/* Coalesced re-runs (critic-driven iterate loop): show "↻N" so one bubble conveys "revised
              N times" instead of N identical stacked bubbles. Hidden for a single-pass agent. */}
          {m.attempts > 1 && <span title={t('chat.revised')} className="rounded bg-white/[0.06] px-1 text-[11px] font-normal text-slate-400">↻{m.attempts}</span>}
          {!m.done && <span className="text-xs font-normal text-teal-300">{t('chat.working')}</span>}
        </div>
        {m.tools.map((tl, i) => {
          const key = TOOL_LABEL[tl.tool]
          return (
            <div key={i} className="ml-1 text-xs text-slate-400">
              <span className="text-violet-300">{key ? t(key) : tl.tool}</span>{tl.ok === undefined ? ' …' : tl.ok ? ' ✓' : ' ✗'}
            </div>
          )
        })}
        {/* HONEST per-agent cost ("12.3k tok · 1 tool · 42s") — the transparency badge that used to
            ride the retired pipeline step. Absent/zero usage (Trace, mock) shows time only, never a
            fabricated "0 tok". */}
        {(() => { const badge = m.metrics ? metricsBadge(t, m.metrics) : undefined; return badge
          ? <div className="ml-1 mt-0.5 truncate text-[10px] tabular-nums text-[#07D1AF]/60" title={badge}>{badge}</div>
          : null })()}
      </div>
    </div>
  )
}

/** A human GATE as an inline conversational card — shown ONLY while AWAITING the human (the one
 *  actionable moment). A satisfied/rejected gate renders NOTHING here: the slim trust-ledger header
 *  carries "Spec ✓ / Deploy ✓", so a "satisfied" bubble would just duplicate it (the redundancy the
 *  unified view had when gates lived in BOTH a strip and a bubble). This is now the SOLE gate surface. */
export function GateBubble({ m, onApprove, onConfirm, busy }: { m: GateMsg; onApprove: () => void; onConfirm: () => void; busy?: boolean }) {
  const { t } = useI18n()
  if (m.state !== 'awaiting') return null
  const isSpec = m.gate === 'spec_approval'
  return (
    // COHESIVE inline gate (UX feedback): a COMPACT fit-content bubble that reads as part of the
    // conversation flow right under the result it gates — not a full-width detached panel. The
    // label + state + action sit on one tight row so it "sticks" to the thread above it.
    <div className="flex items-start gap-3">
      <Avatar role="orchestrator" />
      <div className="inline-flex w-fit max-w-md items-center gap-3 rounded-2xl rounded-tl-sm border border-teal-400/25 bg-teal-400/[0.05] px-3.5 py-2">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-widest text-slate-500">{t('chat.gate.label')} · {t(`chat.gate.${m.gate}`)}</div>
          <div className="text-sm text-amber-300">{t(`gate.state.${m.state}`)}</div>
        </div>
        <button onClick={isSpec ? onApprove : onConfirm} disabled={busy}
          className="shrink-0 rounded-md bg-teal-500/90 px-3 py-1 text-sm font-medium text-slate-900 hover:bg-teal-400 disabled:opacity-40">
          {t(isSpec ? 'chat.approve' : 'chat.confirm')}
        </button>
      </div>
    </div>
  )
}

/** A parked-run RECOVERY decision as an inline card — the actionable surface that USED to live on
 *  the pipeline strip (now retired). Shown only while AWAITING; once resolved it goes quiet (the
 *  next bubble — a re-run, a verify, a done — carries the outcome). GATE-SAFE: proceed/retry POST to
 *  the owner-scoped recovery routes; the server re-runs REAL verification and never bypasses a gate. */
export function RecoveryBubble({ m, onProceed, onAbandon, onRetry, onConfirm, busy }: {
  m: RecoveryMsg; onProceed: () => void; onAbandon: () => void; onRetry: () => void; onConfirm: () => void; busy?: boolean
}) {
  const { t } = useI18n()
  if (m.state !== 'awaiting') return null
  const hint = m.recovery === 'critic_resolution' ? 'recovery.critic.hint' : m.recovery === 'verify_failed' ? 'recovery.verify.hint' : 'recovery.push.hint'
  return (
    <div className="flex items-start gap-3">
      <Avatar role="orchestrator" />
      <div className="w-fit max-w-md rounded-2xl rounded-tl-sm border border-amber-400/30 bg-amber-400/[0.06] px-3.5 py-2.5">
        <div className="mb-2 text-sm text-amber-200">{t(hint)}</div>
        {m.recovery === 'critic_resolution' && (
          <div className="flex flex-wrap gap-1.5">
            <button onClick={onProceed} disabled={busy}
              className="rounded-md bg-gradient-to-r from-[#07D1AF] to-violet-500 px-3 py-1 text-sm font-semibold text-slate-900 disabled:opacity-40">{t('recovery.critic.proceed')}</button>
            <button onClick={onAbandon} disabled={busy}
              className="rounded-md border border-rose-400/40 px-3 py-1 text-sm font-semibold text-rose-200 hover:bg-rose-400/10 disabled:opacity-40">{t('recovery.critic.abandon')}</button>
          </div>
        )}
        {m.recovery === 'verify_failed' && (
          <button onClick={onRetry} disabled={busy}
            className="rounded-md bg-gradient-to-r from-amber-400 to-[#07D1AF] px-3 py-1 text-sm font-semibold text-slate-900 disabled:opacity-40">{t('recovery.verify.retry')}</button>
        )}
        {m.recovery === 'push_failed' && (
          <button onClick={onConfirm} disabled={busy}
            className="rounded-md bg-gradient-to-r from-amber-400 to-[#07D1AF] px-3 py-1 text-sm font-semibold text-slate-900 disabled:opacity-40">{t('recovery.push.retry')}</button>
        )}
      </div>
    </div>
  )
}

export function VerifyBubble({ m }: { m: VerifyMsg }) {
  const { t } = useI18n()
  return (
    <div className="flex items-start gap-3">
      <Avatar role="trace" />
      <div className={`rounded-2xl rounded-tl-sm border px-4 py-2 text-sm ${m.passed ? 'border-emerald-400/30 bg-emerald-400/[0.06] text-emerald-200' : 'border-rose-400/30 bg-rose-400/[0.06] text-rose-200'}`}>
        {m.passed ? `✓ ${t('chat.verified')}` : `✗ ${t('chat.notVerified')}`} · {m.testsRun} {t(m.testsRun === 1 ? 'chat.test' : 'chat.tests')}
        {/* HONESTY: a simulated (demo/mock) pass must never read as a real verification — same marker the Trust Report + /health carry. */}
        {m.demo && <span className="ml-2 rounded bg-amber-400/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-200">{t('chat.chip.demo')}</span>}
      </div>
    </div>
  )
}

/** READ-ONLY status card — the critic's automatic verdict, NOT a human gate (no button). */
export function CodeReviewBubble({ m }: { m: CodeReviewMsg }) {
  const { t } = useI18n()
  const tone = m.critical
    ? 'border-rose-400/30 bg-rose-400/[0.06] text-rose-200'
    : m.approved
      ? 'border-emerald-400/30 bg-emerald-400/[0.06] text-emerald-200'
      : 'border-amber-400/30 bg-amber-400/[0.06] text-amber-200'
  const verdict = m.critical ? t('chat.codeReview.critical') : m.approved ? t('chat.codeReview.approved') : t('chat.codeReview.rejected')
  return (
    <div className="flex items-start gap-3">
      <Avatar role="critic" />
      <div className={`rounded-2xl rounded-tl-sm border px-4 py-2 text-sm ${tone}`}>
        <span className="text-xs uppercase tracking-widest opacity-70">{t('chat.codeReview.label')}</span>
        {' · '}{verdict}
        {' · '}{m.findings} {t('chat.codeReview.findings')}
        {m.iteration > 1 ? <> · {t('chat.codeReview.iteration')} {m.iteration}</> : null}
      </div>
    </div>
  )
}

export function PreviewBubble({ m }: { m: PreviewMsg }) {
  const { t } = useI18n()
  // A recoverable boot FAILURE shows as a rose card with its reason — never collapsed to
  // a misleading "starting…" (text-only, XSS-safe). Otherwise the usual ready/starting card.
  return m.error ? (
    <div className="flex items-start gap-3">
      <Avatar role="orchestrator" />
      <div className="rounded-2xl rounded-tl-sm border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-sm text-rose-300">
        {t(m.error.status === 'unsupported' ? 'preview.unsupported' : 'preview.failed')}
        {m.error.reason ? <> · <span className="break-all text-rose-200/90">{m.error.reason}</span></> : null}
      </div>
    </div>
  ) : (
    <div className="flex items-start gap-3">
      <Avatar role="orchestrator" />
      <div className="rounded-2xl rounded-tl-sm border border-white/10 bg-white/[0.03] px-4 py-2 text-sm text-slate-200">
        {m.ready ? t('chat.preview.ready') : t('chat.preview.starting')}{m.url ? <> · <span className="break-all text-teal-300">{m.url}</span></> : null}
      </div>
    </div>
  )
}

export function ErrorBubble({ m }: { m: ErrorMsg }) {
  return <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{m.text}</div>
}

export function DoneBubble({ m }: { m: DoneMsg }) {
  const { t } = useI18n()
  return (
    <div className="flex items-start gap-3">
      <Avatar role="orchestrator" />
      <div className="rounded-2xl rounded-tl-sm border border-emerald-400/30 bg-gradient-to-br from-emerald-400/15 to-teal-400/10 px-4 py-2 text-sm text-emerald-200">
        🚀 {t('chat.shipped')}{m.verified ? ` · ${t('chat.verified').toLowerCase()}` : ''}{m.provider ? ` · ${m.provider}` : ''}
      </div>
    </div>
  )
}

/** Render ONE folded bubble by kind — the shared dispatcher reused by both ChatThread (below)
 *  and RunBlock (inline). Narration is suppressed (returns null). */
export function ChatBubble({ m, onApprove, onConfirm, onConfirmRecovery, onProceed, onAbandon, onRetry, busy }: {
  m: ChatMessage; onApprove: () => void; onConfirm: () => void
  /** Recovery handlers — only the 'recovery' bubble uses them; optional so non-recovery callers omit.
   *  `onConfirmRecovery` is the push_failed RETRY: it must target THIS run's session (bound by the
   *  caller), NOT the active-run confirm `onConfirm` uses for the push_confirm GATE — a non-active
   *  run's retry would otherwise confirm the wrong (active) session. Falls back to onConfirm. */
  onConfirmRecovery?: () => void; onProceed?: () => void; onAbandon?: () => void; onRetry?: () => void; busy?: boolean
}) {
  const noop = (): void => {}
  switch (m.kind) {
    case 'user': return <UserBubble m={m} />
    case 'narration': return <NarrationBubble />
    case 'agent': return <AgentBubble m={m} />
    case 'gate': return <GateBubble m={m} onApprove={onApprove} onConfirm={onConfirm} {...(busy !== undefined ? { busy } : {})} />
    case 'recovery': return <RecoveryBubble m={m} onProceed={onProceed ?? noop} onAbandon={onAbandon ?? noop} onRetry={onRetry ?? noop} onConfirm={onConfirmRecovery ?? onConfirm} {...(busy !== undefined ? { busy } : {})} />
    case 'verify': return <VerifyBubble m={m} />
    case 'code_review': return <CodeReviewBubble m={m} />
    case 'preview': return <PreviewBubble m={m} />
    case 'error': return <ErrorBubble m={m} />
    case 'done': return <DoneBubble m={m} />
    default: return null
  }
}

interface Props { messages: ChatMessage[]; onApprove: () => void; onConfirm: () => void; busy?: boolean }

export function ChatThread({ messages, onApprove, onConfirm, busy }: Props) {
  return (
    <div className="flex flex-col gap-4">
      {messages.map(m => (
        <ChatBubble key={m.id} m={m} onApprove={onApprove} onConfirm={onConfirm} {...(busy !== undefined ? { busy } : {})} />
      ))}
    </div>
  )
}
