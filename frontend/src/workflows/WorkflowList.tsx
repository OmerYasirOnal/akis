import { useEffect, useState } from 'react'
import type { WorkflowConfig } from '@akis/shared'
import { ApiClient, ApiError } from '../api/client.js'
import { Card, SectionTitle, Button } from '../ui/kit.js'
import { useI18n } from '../i18n/I18nContext.js'

/**
 * WorkflowList (F2 builder UI) — the saved presets, latest-per-id from GET /api/workflows,
 * each with its current version. Expanding a row probes the prior versions client-side
 * (decision: api.getWorkflow(id, n) for n = version-1 .. 1), guarding a 404 gracefully so
 * a gap in the version chain never produces an unhandled rejection. Edit/New are lifted to
 * the parent page (which swaps in the builder); the list holds no save authority.
 */
export function WorkflowList({
  api,
  onEdit,
  onNew,
}: {
  api: ApiClient
  onEdit: (wf: WorkflowConfig) => void
  onNew: () => void
}) {
  const { t } = useI18n()
  const [workflows, setWorkflows] = useState<WorkflowConfig[] | undefined>()
  const [expanded, setExpanded] = useState<string | null>(null)
  // Prior versions per id, fetched lazily on expand (current version is already in `workflows`).
  const [history, setHistory] = useState<Record<string, WorkflowConfig[]>>({})

  useEffect(() => { void api.listWorkflows().then(setWorkflows).catch(() => setWorkflows([])) }, [api])

  const toggle = async (wf: WorkflowConfig): Promise<void> => {
    if (expanded === wf.id) { setExpanded(null); return }
    setExpanded(wf.id)
    if (history[wf.id] || wf.version <= 1) return
    // Probe version-1 down to 1, skipping any version that 404s (a gap in the chain).
    const prior: WorkflowConfig[] = []
    for (let v = wf.version - 1; v >= 1; v--) {
      try {
        prior.push(await api.getWorkflow(wf.id, v))
      } catch (e) {
        if (ApiError.is(e) && e.status === 404) continue // graceful skip, no unhandled rejection
        throw e
      }
    }
    setHistory(h => ({ ...h, [wf.id]: prior }))
  }

  if (!workflows) return <p className="text-slate-500">{t('workflows.list.loading')}</p>

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <SectionTitle sub={t('workflows.sub')}>{t('workflows.list.title')}</SectionTitle>
        <Button onClick={onNew}>{t('workflows.list.new')}</Button>
      </div>

      {workflows.length === 0 ? (
        <Card className="p-8 text-center text-slate-400">{t('workflows.list.empty')}</Card>
      ) : (
        <ul className="space-y-3">
          {workflows.map(wf => {
            const isOpen = expanded === wf.id
            const versions = [wf.version, ...(history[wf.id]?.map(h => h.version) ?? [])]
            return (
              <li key={wf.id}>
                <Card className="p-4">
                  <div data-testid={`workflow-${wf.id}`}>
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="font-semibold text-slate-100">{wf.name}</div>
                        <div className="text-xs text-slate-500">
                          {t('workflows.list.version')} {wf.version} · {wf.agents.length} {t('workflows.list.agents')}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {wf.version > 1 && (
                          <Button variant="ghost" onClick={() => void toggle(wf)}>
                            {isOpen ? t('workflows.list.hideHistory') : t('workflows.list.showHistory')}
                          </Button>
                        )}
                        <Button variant="ghost" onClick={() => onEdit(wf)}>{t('workflows.list.edit')}</Button>
                      </div>
                    </div>

                    {isOpen && wf.version > 1 && (
                      <div data-testid={`history-${wf.id}`} className="mt-3 border-t border-white/10 pt-3">
                        <div className="mb-2 text-[11px] uppercase tracking-widest text-slate-500">{t('workflows.list.versions')}</div>
                        <ul className="flex flex-wrap gap-2">
                          {versions.map(v => (
                            <li key={v} className="rounded-full bg-white/[0.06] px-2.5 py-0.5 text-xs font-medium text-slate-300">v{v}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </Card>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
