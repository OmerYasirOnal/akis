import { useEffect, useMemo, useState } from 'react'
import { CORE_ROLES, type Role, type AgentConfig } from '@akis/shared'
import { ApiClient, type ProviderInfo } from '../api/client.js'
import { useI18n } from '../i18n/I18nContext.js'
import { Select } from '../ui/kit.js'

type Selection = Record<string, { providerId: string; modelId: string }>

/**
 * Agents & Workflows tab (F2-AC6/AC8): the core roster with a per-agent model picker
 * fed by GET /api/providers, plus saving the selection as a WorkflowConfig. Read-only
 * roster (roles are structural); only model selection is editable here.
 */
export function AgentsTab({ api }: { api: ApiClient }) {
  const { t } = useI18n()
  const [providers, setProviders] = useState<ProviderInfo[] | undefined>()
  const [sel, setSel] = useState<Selection>({})
  const [name, setName] = useState('default')
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)

  // On failure, fall back to an empty list so the tab renders (no infinite "loading"
  // and no unhandled rejection).
  useEffect(() => { void api.listProviders().then(setProviders).catch(() => setProviders([])) }, [api])

  // Show every catalog provider (configured or not) so the user can pick a model and
  // add its key in Settings; availability is per-row info, not a hide filter.
  const available = useMemo(() => providers ?? [], [providers])

  const setAgent = (role: string, providerId: string, modelId: string): void => {
    setSel(s => ({ ...s, [role]: { providerId, modelId } }))
    setSaved(false)
  }

  const save = async (): Promise<void> => {
    setBusy(true); setSaved(false)
    try {
      const agents: AgentConfig[] = CORE_ROLES.map((role: Role) => {
        const m = sel[role]
        return m ? { role, model: { providerId: m.providerId, modelId: m.modelId } } : { role }
      })
      await api.saveWorkflow({ name: name.trim() || 'default', agents })
      setSaved(true)
    } finally { setBusy(false) }
  }

  if (!providers) return <p className="text-slate-500">{t('agents.loading')}</p>

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-slate-100">{t('agents.heading')}</h2>
      <div className="flex items-center gap-2">
        <label className="text-xs uppercase tracking-widest text-slate-500" htmlFor="wf-name">{t('agents.workflowName')}</label>
        <input id="wf-name" aria-label={t('agents.workflowName')} value={name} onChange={e => { setName(e.target.value); setSaved(false) }}
          className="rounded border border-white/10 bg-white/[0.04] px-2 py-1 text-sm text-slate-100" />
      </div>

      <div className="overflow-hidden rounded-lg border border-white/10">
        <div className="grid grid-cols-3 gap-2 border-b border-white/10 bg-white/[0.03] px-3 py-2 text-[10px] uppercase tracking-widest text-slate-500">
          <span>{t('agents.roster')}</span><span>{t('agents.provider')}</span><span>{t('agents.model')}</span>
        </div>
        {CORE_ROLES.map(role => {
          const cur = sel[role]
          const provider = available.find(p => p.id === cur?.providerId)
          return (
            <div key={role} className="grid grid-cols-3 items-center gap-2 px-3 py-2 text-sm">
              <span className="font-medium text-slate-200">{role}</span>
              <Select aria-label={`${role}-provider`} className="py-1.5 text-sm"
                value={cur?.providerId ?? ''}
                onChange={e => { const p = available.find(x => x.id === e.target.value); setAgent(role, e.target.value, p?.defaultModel ?? '') }}>
                <option value="">{t('agents.default')}</option>
                {available.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
              </Select>
              <Select aria-label={`${role}-model`} className="py-1.5 text-sm disabled:opacity-50"
                value={cur?.modelId ?? ''} disabled={!provider}
                onChange={e => cur && setAgent(role, cur.providerId, e.target.value)}>
                <option value="">{t('agents.default')}</option>
                {provider?.models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
              </Select>
            </div>
          )
        })}
      </div>

      <div className="flex items-center gap-3">
        <button onClick={save} disabled={busy}
          className="rounded-lg bg-gradient-to-r from-cyan-400 to-violet-500 px-4 py-2 font-semibold text-slate-900 disabled:opacity-40">
          {t('agents.save')}
        </button>
        {saved && <span className="text-sm text-emerald-300">{t('agents.saved')}</span>}
      </div>
    </div>
  )
}
