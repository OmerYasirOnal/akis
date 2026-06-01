import type { ChatMessage } from './chatModel.js'
import { useI18n } from '../i18n/I18nContext.js'

const ROLE_TINT: Record<string, string> = {
  orchestrator: 'from-cyan-400/30 to-cyan-400/5 text-cyan-200',
  scribe: 'from-sky-400/30 to-sky-400/5 text-sky-200',
  proto: 'from-violet-400/30 to-violet-400/5 text-violet-200',
  trace: 'from-emerald-400/30 to-emerald-400/5 text-emerald-200',
  critic: 'from-amber-400/30 to-amber-400/5 text-amber-200',
}
const AKIS_NAME: Record<string, string> = { orchestrator: 'AKIS', scribe: 'Scribe', proto: 'Proto', trace: 'Trace', critic: 'Critic' }
const dot = (ok?: boolean, done?: boolean): string => ok === false ? 'bg-rose-400' : done ? 'bg-emerald-400' : 'bg-cyan-400 animate-pulse'

function Avatar({ role }: { role: string }) {
  return <div className={`grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br text-[10px] font-bold ${ROLE_TINT[role] ?? 'from-slate-500/30 to-slate-500/5 text-slate-300'}`}>{(AKIS_NAME[role] ?? role).slice(0, 2)}</div>
}

interface Props { messages: ChatMessage[]; onApprove: () => void; onConfirm: () => void; busy?: boolean }

export function ChatThread({ messages, onApprove, onConfirm, busy }: Props) {
  const { t } = useI18n()
  return (
    <div className="flex flex-col gap-4">
      {messages.map(m => {
        switch (m.kind) {
          case 'user':
            return (
              <div key={m.id} className="flex justify-end">
                <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-gradient-to-br from-cyan-500/90 to-violet-500/90 px-4 py-2 text-slate-950">{m.text}</div>
              </div>
            )
          case 'narration':
            return (
              <div key={m.id} className="flex items-start gap-3">
                <Avatar role={m.agent} />
                <div className="max-w-[80%] rounded-2xl rounded-tl-sm bg-white/[0.05] px-4 py-2 text-slate-200">{m.text}</div>
              </div>
            )
          case 'agent':
            return (
              <div key={m.id} className="flex items-start gap-3">
                <Avatar role={m.agent} />
                <div className="max-w-[80%] rounded-2xl rounded-tl-sm border border-white/10 bg-white/[0.03] px-4 py-3">
                  <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-100">
                    <span className={`h-2 w-2 rounded-full ${dot(m.ok, m.done)}`} />{AKIS_NAME[m.agent] ?? m.agent}
                    {!m.done && <span className="text-xs font-normal text-cyan-300">{t('chat.working')}</span>}
                  </div>
                  {m.tools.map((t, i) => (
                    <div key={i} className="ml-1 text-xs text-slate-400"><span className="text-violet-300">{t.tool}</span>{t.ok === undefined ? ' …' : t.ok ? ' ✓' : ' ✗'}</div>
                  ))}
                  {m.notes.map((nt, i) => <div key={`n${i}`} className="ml-1 text-xs italic text-slate-500">{nt}</div>)}
                </div>
              </div>
            )
          case 'gate': {
            const isSpec = m.gate === 'spec_approval'
            const tone = m.state === 'satisfied' ? 'text-emerald-300' : m.state === 'rejected' ? 'text-rose-300' : 'text-amber-300'
            return (
              <div key={m.id} className="flex items-start gap-3">
                <Avatar role="orchestrator" />
                <div className="w-full max-w-[80%] rounded-2xl rounded-tl-sm border border-cyan-400/20 bg-cyan-400/[0.04] px-4 py-3">
                  <div className="text-xs uppercase tracking-widest text-slate-500">Gate · {t(`chat.gate.${m.gate}`)}</div>
                  <div className={`mb-2 text-sm ${tone}`}>{m.state}</div>
                  {m.state === 'awaiting' && (
                    <button onClick={isSpec ? onApprove : onConfirm} disabled={busy}
                      className="rounded bg-cyan-500/90 px-3 py-1 text-sm font-medium text-slate-900 disabled:opacity-40">
                      {t(isSpec ? 'chat.approve' : 'chat.confirm')}
                    </button>
                  )}
                </div>
              </div>
            )
          }
          case 'verify':
            return (
              <div key={m.id} className="flex items-start gap-3">
                <Avatar role="trace" />
                <div className={`rounded-2xl rounded-tl-sm border px-4 py-2 text-sm ${m.passed ? 'border-emerald-400/30 bg-emerald-400/[0.06] text-emerald-200' : 'border-rose-400/30 bg-rose-400/[0.06] text-rose-200'}`}>
                  {m.passed ? `✓ ${t('chat.verified')}` : `✗ ${t('chat.notVerified')}`} · {m.testsRun} {t('chat.tests')}
                </div>
              </div>
            )
          case 'preview':
            return (
              <div key={m.id} className="flex items-start gap-3">
                <Avatar role="orchestrator" />
                <div className="rounded-2xl rounded-tl-sm border border-white/10 bg-white/[0.03] px-4 py-2 text-sm text-slate-200">
                  {m.ready ? t('chat.preview.ready') : t('chat.preview.starting')}{m.url ? <> · <span className="break-all text-cyan-300">{m.url}</span></> : null}
                </div>
              </div>
            )
          case 'error':
            return <div key={m.id} className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{m.text}</div>
          case 'done':
            return (
              <div key={m.id} className="flex items-start gap-3">
                <Avatar role="orchestrator" />
                <div className="rounded-2xl rounded-tl-sm border border-emerald-400/30 bg-gradient-to-br from-emerald-400/15 to-cyan-400/10 px-4 py-2 text-sm text-emerald-200">
                  🚀 {t('chat.shipped')}{m.verified ? ` · ${t('chat.verified').toLowerCase()}` : ''}{m.provider ? ` · ${m.provider}` : ''}
                </div>
              </div>
            )
          default:
            return null
        }
      })}
    </div>
  )
}
