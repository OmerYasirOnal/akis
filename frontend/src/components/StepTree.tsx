import type { AgentLane, StepNode } from '../live/types.js'

const dot = (ok?: boolean, done?: boolean): string =>
  ok === false ? 'bg-rose-500' : done ? 'bg-emerald-400' : 'bg-cyan-400 animate-pulse'

function Step({ step }: { step: StepNode }) {
  return (
    <li className="ml-1 border-l border-white/10 pl-3 py-1">
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${dot(step.ok, step.done)}`} />
        <span className="font-medium text-slate-100">{step.agent}</span>
        {!step.done && <span className="text-xs text-cyan-300">running…</span>}
      </div>
      {step.tools.map((t, i) => (
        <div key={i} className="ml-4 text-xs text-slate-400">
          <span className="text-violet-300">{t.tool}</span>
          {t.ok === undefined ? ' …' : t.ok ? ' ✓' : ' ✗'}
        </div>
      ))}
      {step.notes.map((n, i) => (
        <div key={`n${i}`} className="ml-4 text-xs italic text-slate-500">{n}</div>
      ))}
    </li>
  )
}

export function StepTree({ lanes }: { lanes: AgentLane[] }) {
  if (lanes.length === 0) return <p className="text-sm text-slate-500">No activity yet.</p>
  return (
    <div className="space-y-4">
      {lanes.map(lane => (
        <div key={lane.laneId}>
          <h4 className="mb-1 text-xs uppercase tracking-widest text-slate-500">lane: {lane.laneId}</h4>
          <ul>{lane.steps.map((s, i) => <Step key={i} step={s} />)}</ul>
        </div>
      ))}
    </div>
  )
}
