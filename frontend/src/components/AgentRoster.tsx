import { memo } from 'react'
import type { Role } from '@akis/shared'
import type { SessionView } from '../live/types.js'
import { useI18n } from '../i18n/I18nContext.js'
import { AGENT_NAMES } from '../agents/names.js'

export type AgentPresence = 'idle' | 'working' | 'done' | 'failed'

/** The AKIS core roster, in pipeline order. orchestrator = AKIS itself. Display names
 *  come from the shared AGENT_NAMES source of truth. */
export const ROSTER: { role: Role; name: string; tint: string }[] = [
  { role: 'orchestrator', name: AGENT_NAMES.orchestrator, tint: 'from-teal-400 to-teal-300' },
  { role: 'scribe', name: AGENT_NAMES.scribe, tint: 'from-sky-400 to-sky-300' },
  { role: 'proto', name: AGENT_NAMES.proto, tint: 'from-violet-400 to-violet-300' },
  { role: 'trace', name: AGENT_NAMES.trace, tint: 'from-emerald-400 to-emerald-300' },
  { role: 'critic', name: AGENT_NAMES.critic, tint: 'from-amber-400 to-amber-300' },
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
  // Chat-seeded builds short-circuit Scribe's run() (the spec was authored + approved in chat),
  // so there is NO scribe lane step — yet the spec stage genuinely happened. A satisfied
  // spec-approval gate is that proof, so Scribe reads 'done' (not 'idle'/"beklemede") here. The
  // backend now also emits a synthetic scribe agent_start/agent_end on that path, so a live build
  // takes the lane-step branch above; this fallback covers any view folded without those events
  // (e.g. an older replayed log). Mirrors the orchestrator status fallback.
  if (role === 'scribe' && view.gates?.specApproval?.state === 'satisfied') return 'done'
  return 'idle'
}

const DOT: Record<AgentPresence, string> = {
  idle: 'bg-slate-400',
  working: 'bg-teal-400 animate-pulse shadow-[0_0_8px_2px_rgba(7,209,175,0.6)]',
  done: 'bg-emerald-400',
  failed: 'bg-rose-400',
}

/** A compact, always-visible identity strip for the AKIS agents — so it's clear which
 *  AI agents are doing the work, and what each one is responsible for, live.
 *
 *  F1(b) — `scribeOverride` is a PRE-BUILD, chat-level Scribe presence lifted up from AkisChat (the
 *  REAL Scribe handoff happens at chat time, before any run/SessionView exists, so the view-derived
 *  presence would sit 'idle'). It only ever raises Scribe ABOVE what the view says — 'working' while
 *  drafting, 'done' once the spec card is present — and is ignored once a build is live (AkisChat
 *  reports 'idle' then, so the event-driven `presenceOf` takes over unchanged). Pure observability. */
export const AgentRoster = memo(function AgentRoster({ view, scribeOverride }: { view: SessionView; scribeOverride?: AgentPresence }) {
  const { t } = useI18n()
  return (
    <div className="flex flex-wrap gap-2">
      {ROSTER.map(a => {
        const p = a.role === 'scribe' && scribeOverride && scribeOverride !== 'idle' ? scribeOverride : presenceOf(view, a.role)
        return (
          <div key={a.role} title={t(`role.${a.role}.what`)}
            className="group flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 transition hover:border-white/20">
            <span className={`grid h-6 w-6 place-items-center rounded-full bg-gradient-to-br ${a.tint} text-[9px] font-black text-slate-950`}>{a.name.slice(0, 2)}</span>
            <span className="text-xs font-semibold text-slate-200">{a.name}</span>
            <span title={t(`roster.status.${p}`)} className={`h-2 w-2 rounded-full ${DOT[p]}`} aria-hidden="true" />
            <span className="sr-only">{t(`roster.status.${p}`)}</span>
            <span className="hidden text-[10px] text-slate-400 sm:inline" aria-hidden="true">{t(`roster.status.${p}`)}</span>
          </div>
        )
      })}
    </div>
  )
})
