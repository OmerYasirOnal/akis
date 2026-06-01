import { useState } from 'react'
import { ApiClient, ApiError } from '../api/client.js'
import { useLiveSession } from '../live/useLiveSession.js'
import { StepTree } from './StepTree.js'
import { GateCards } from './GateCards.js'
import { PreviewPanel } from './PreviewPanel.js'

/**
 * Live view of one session: left = agent step tree + gate actions + errors,
 * right = the preview/test surface. Approve auto-runs to verification; the gates
 * are still enforced server-side (the FE holds no gate authority).
 */
export function SessionView({ sessionId, api, baseUrl = '' }: { sessionId: string; api: ApiClient; baseUrl?: string }) {
  const view = useLiveSession(sessionId, api, baseUrl)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | undefined>()

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true); setActionError(undefined)
    try { await fn() }
    catch (e) { setActionError(ApiError.is(e) ? `${e.code ?? 'error'}: ${e.message}` : String(e)) }
    finally { setBusy(false) }
  }
  const approve = (): Promise<void> => act(async () => { await api.approve(sessionId); await api.run(sessionId) })
  const confirm = (): Promise<void> => act(() => api.confirm(sessionId))

  if (!view) return <p className="text-slate-500">Connecting to {sessionId}…</p>

  return (
    <div className="grid grid-cols-2 gap-6">
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <span className="rounded bg-white/10 px-2 py-0.5 text-xs text-slate-300">{view.status}</span>
          {view.provider && <span className="text-xs text-slate-500">on {view.provider}</span>}
        </div>
        <GateCards view={view} onApprove={approve} onConfirm={confirm} busy={busy} />
        {(actionError || view.errors.length > 0) && (
          <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-2 text-xs text-rose-300">
            {actionError && <div>{actionError}</div>}
            {view.errors.map((e, i) => <div key={i}>{e}</div>)}
          </div>
        )}
        <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
          <StepTree lanes={view.lanes} />
        </div>
      </section>
      <section className="rounded-lg border border-white/10 bg-white/[0.02] p-4">
        <PreviewPanel view={view} />
      </section>
    </div>
  )
}
