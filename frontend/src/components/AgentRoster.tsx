import type { Role } from '@akis/shared'
import type { SessionView } from '../live/types.js'
import { useI18n } from '../i18n/I18nContext.js'

export type AgentPresence = 'idle' | 'working' | 'done' | 'failed'

/** The AKIS core roster, in pipeline order. orchestrator = AKIS itself. */
export const ROSTER: { role: Role; name: string; tint: string }[] = [
  { role: 'orchestrator', name: 'AKIS', tint: 'from-cyan-400 to-cyan-300' },
  { role: 'scribe', name: 'Scribe', tint: 'from-sky-400 to-sky-300' },
  { role: 'proto', name: 'Proto', tint: 'from-violet-400 to-violet-300' },
  { role: 'trace', name: 'Trace', tint: 'from-emerald-400 to-emerald-300' },
  { role: 'critic', name: 'Critic', tint: 'from-amber-400 to-amber-300' },
]

/** Derive an agent's live presence from the session view: the most recent step for
 *  that role decides working/done/failed; absence = idle. orchestrator also reflects
 *  the overall run (running → working, done → done, failed → failed). */
export function presenceOf(view: SessionView, role: Role): AgentPresence {
  let last: { done: boolean; ok?: boolean } | undefined
  for (const lane of view.lanes) for (const s of lane.steps) if (s.agent === role) last = s
  if (last) {
    if (!last.done) return 'working'
    return last.ok === false ? 'failed' : 'done'
  }
  if (role === 'orchestrator') {
    if (view.status === 'running' || view.status === 'started') return 'working'
    if (view.status === 'done') return 'done'
    if (view.status === 'failed') return 'failed'
  }
  return 'idle'
}

const DOT: Record<AgentPresence, string> = {
  idle: 'bg-slate-600',
  working: 'bg-cyan-400 animate-pulse shadow-[0_0_8px_2px_rgba(34,211,238,0.6)]',
  done: 'bg-emerald-400',
  failed: 'bg-rose-400',
}

/** A compact, always-visible identity strip for the AKIS agents — so it's clear which
 *  AI agents are doing the work, and what each one is responsible for, live. */
export function AgentRoster({ view }: { view: SessionView }) {
  const { t } = useI18n()
  return (
    <div className="flex flex-wrap gap-2">
      {ROSTER.map(a => {
        const p = presenceOf(view, a.role)
        return (
          <div key={a.role} title={t(`role.${a.role}.what`)}
            className="group flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 transition hover:border-white/20">
            <span className={`grid h-6 w-6 place-items-center rounded-full bg-gradient-to-br ${a.tint} text-[9px] font-black text-slate-950`}>{a.name.slice(0, 2)}</span>
            <span className="text-xs font-semibold text-slate-200">{a.name}</span>
            <span className={`h-1.5 w-1.5 rounded-full ${DOT[p]}`} />
            <span className="hidden text-[10px] text-slate-500 sm:inline">{t(`roster.status.${p}`)}</span>
          </div>
        )
      })}
    </div>
  )
}
