import { memo, useEffect, useState } from 'react'
import type { Role } from '@akis/shared'
import type { SessionView } from '../live/types.js'
import { useI18n } from '../i18n/I18nContext.js'
import type { StringKey } from '../i18n/catalog.js'
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

/** The SINGLE active role = the agent whose most-recent LANE STEP is still open (working). This is
 *  the one doing visible work; we deliberately do NOT let the orchestrator's status-derived 'working'
 *  (AKIS is "working" for the whole run by definition) steal the highlight from the agent actually
 *  running — the highlight tracks the live worker (Scribe/Proto/Trace/Critic), matching the mockup.
 *  At most one lane step is open at a time in the linear pipeline; if several ever overlap we pick the
 *  FIRST in ROSTER order so the highlight is deterministic. undefined = nothing is actively running. */
export function activeRole(view: SessionView): Role | undefined {
  // A role with a genuinely OPEN lane step (presence 'working' that isn't the orchestrator fallback).
  let openRole: Role | undefined
  for (const lane of view.lanes) for (const s of lane.steps) if (!s.done) openRole = s.agent
  if (openRole) return openRole
  // No agent step is open. Only then does the orchestrator's own status-derived 'working' count, so a
  // brief "AKIS is starting the run" window (before the first agent step) still shows a live highlight.
  return presenceOf(view, 'orchestrator') === 'working' ? 'orchestrator' : undefined
}

/** Per-role live caption key (a generic 'working…' fallback covers any non-core agent). The keys
 *  exist in BOTH catalogs, so the template literal stays a known StringKey union. */
export function captionKey(role: Role): StringKey {
  const known: Role[] = ['orchestrator', 'scribe', 'proto', 'trace', 'critic']
  return known.includes(role) ? (`roster.caption.${role}` as StringKey) : 'roster.caption.working'
}

/** A compact, always-visible identity strip for the AKIS agents — so it's clear which
 *  AI agents are doing the work, and what each one is responsible for, live. The ONE
 *  currently-running agent gets a teal ring/glow + a live caption (data-active="true");
 *  finished agents collapse to a quiet style; idle agents keep their state dot. */
export const AgentRoster = memo(function AgentRoster({ view }: { view: SessionView }) {
  const { t } = useI18n()
  // One scan up front so the chips can read "is this the active one?" without each re-scanning.
  const active = activeRole(view)
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* "▶ Şu an" — a quiet leading tag, shown only while an agent is actively running (mirrors the
          v3 mockup's nowtag). It anchors the highlight so the strip reads as a live activity, not a
          static legend. */}
      {active && (
        <span className="inline-flex items-center gap-1 rounded-full border border-[#07D1AF]/30 bg-[#07D1AF]/[0.08] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-teal-200">
          <span aria-hidden>▶</span> {t('roster.now')}
        </span>
      )}
      {ROSTER.map(a => {
        const p = presenceOf(view, a.role)
        const isActive = a.role === active
        const isDone = p === 'done'
        return (
          <div key={a.role} data-role={a.role} data-active={isActive ? 'true' : undefined}
            title={t(`role.${a.role}.what`)}
            className={`group flex items-center gap-2 rounded-full border px-3 py-1.5 transition ${
              isActive
                ? 'border-[#07D1AF]/55 bg-[#07D1AF]/[0.10] shadow-[0_0_0_1px_rgba(7,209,175,0.25),0_0_14px_rgba(7,209,175,0.18)]'
                : isDone
                  ? 'border-white/5 bg-white/[0.015] opacity-70 hover:border-white/15'
                  : 'border-white/10 bg-white/[0.03] hover:border-white/20'
            }`}>
            <span className={`grid h-6 w-6 place-items-center rounded-full bg-gradient-to-br ${a.tint} text-[9px] font-black text-slate-950`}>{a.name.slice(0, 2)}</span>
            <span className={`text-xs font-semibold ${isActive ? 'text-slate-100' : 'text-slate-200'}`}>{a.name}</span>
            <span title={t(`roster.status.${p}`)} className={`h-2 w-2 rounded-full ${DOT[p]}`} aria-hidden="true" />
            <span className="sr-only">{t(`roster.status.${p}`)}</span>
            {/* The active chip shows a per-role LIVE caption ("kod yazıyor…"); the others keep the
                terse status word (hidden on very narrow widths to stay single-row). */}
            {isActive
              ? <span className="text-[10px] font-medium text-teal-200/90">{t(captionKey(a.role))}</span>
              : <span className="hidden text-[10px] text-slate-400 sm:inline" aria-hidden="true">{t(`roster.status.${p}`)}</span>}
          </div>
        )
      })}
    </div>
  )
})

/** A compact progress summary — "Building · <Agent> · k/n · mm:ss" — for the studio to show next to
 *  the roster. It is a TICKER LEAF (its own 1s interval + state, like StartingElapsed) so a tick
 *  re-renders ONLY this badge, never the roster tree. Renders nothing when no agent is running. */
export const BuildProgress = memo(function BuildProgress({ view }: { view: SessionView }) {
  const { t } = useI18n()
  const active = activeRole(view)
  const [elapsed, setElapsed] = useState(0)
  // Restart the ticker whenever the active agent changes (so the time reflects THIS run's progress);
  // the effect runs only on a real role change, not on every parent re-render.
  useEffect(() => {
    if (!active) return
    const startedAt = Date.now()
    setElapsed(0)
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [active])
  if (!active) return null
  // k/n: how many of the pipeline's agents have a step so far (done or running) — a cheap, honest
  // "step k of n" without inventing a fixed plan the run may not follow.
  const seen = new Set<Role>()
  for (const lane of view.lanes) for (const s of lane.steps) seen.add(s.agent)
  const k = seen.size
  const n = ROSTER.length
  const m = Math.floor(elapsed / 60), sec = elapsed % 60
  const name = ROSTER.find(a => a.role === active)?.name ?? active
  return (
    <span role="status" className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10.5px] tabular-nums text-slate-300">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#07D1AF]" aria-hidden />
      {t('roster.progress.building')} · {name} · {k}/{n} · {m.toString().padStart(2, '0')}:{sec.toString().padStart(2, '0')}
    </span>
  )
})
