import type { SessionView } from '../live/types.js'

interface Props {
  view: SessionView
  onApprove: () => void
  onConfirm: () => void
  busy?: boolean
}

const badge = (state?: string): string =>
  state === 'satisfied' ? 'text-emerald-300' : state === 'rejected' ? 'text-rose-300' : 'text-amber-300'

export function GateCards({ view, onApprove, onConfirm, busy }: Props) {
  const spec = view.gates.specApproval
  const push = view.gates.pushConfirm
  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
        <div className="text-xs uppercase tracking-widest text-slate-500">Gate · spec approval</div>
        <div className={`mt-1 text-sm ${badge(spec?.state)}`}>{spec?.state ?? '—'}</div>
        <button
          className="mt-2 rounded bg-cyan-500/90 px-3 py-1 text-sm font-medium text-slate-900 disabled:opacity-40"
          disabled={busy || spec?.state !== 'awaiting'}
          onClick={onApprove}
        >Approve spec</button>
      </div>
      <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
        <div className="text-xs uppercase tracking-widest text-slate-500">Gate · push confirm</div>
        <div className={`mt-1 text-sm ${badge(push?.state)}`}>{push?.state ?? '—'}</div>
        <button
          className="mt-2 rounded bg-violet-500/90 px-3 py-1 text-sm font-medium text-slate-900 disabled:opacity-40"
          disabled={busy || push?.state !== 'awaiting'}
          onClick={onConfirm}
        >Confirm push</button>
      </div>
    </div>
  )
}
