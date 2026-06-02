import { useEffect, useMemo, useState } from 'react'
import {
  CORE_ROLES,
  GATE_TOOLS,
  type Role,
  type AgentConfig,
  type WorkflowConfig,
  type WorkflowConfigInput,
} from '@akis/shared'
import { ApiClient, ApiError, type ProviderInfo } from '../api/client.js'
import { Card, SectionTitle, Button, Field, Input, ErrorNote } from '../ui/kit.js'
import { useI18n } from '../i18n/I18nContext.js'
import {
  clampIterateBudget,
  isGateAllowedForRole,
  validateWorkflowDraft,
  STRUCTURAL_GATES,
  type DraftCatalogProvider,
} from './gatePolicy.js'

/** A small curated, NON-free-text skill list (decision: skills are a curated FE list).
 *  These map onto the agent's `skills[]`; the value is the stable id sent in the payload. */
const CURATED_SKILLS = ['frontend', 'backend', 'testing', 'docs', 'refactor'] as const
type CuratedSkill = typeof CURATED_SKILLS[number]

/** The curated tool palette shown per agent. Gate tools (from GATE_TOOLS) are always
 *  rendered but disabled for any role that doesn't structurally own them — the UI can
 *  never even attempt to grant a gate capability to the wrong role (tighten-only). */
const NON_GATE_TOOLS = ['chat', 'ask'] as const
const TOOL_PALETTE = [...NON_GATE_TOOLS, ...GATE_TOOLS] as const
type ToolId = typeof TOOL_PALETTE[number]

/** Per-role editable draft state. `enabled` agents are included in the saved payload. */
interface AgentDraft {
  providerId: string
  modelId: string
  tools: Set<ToolId>
  skills: Set<CuratedSkill>
}

function emptyAgent(): AgentDraft {
  return { providerId: '', modelId: '', tools: new Set(), skills: new Set() }
}

/** Hydrate per-role drafts from an existing workflow (edit mode) or blanks (new). */
function hydrate(initial?: WorkflowConfig | WorkflowConfigInput): Record<string, AgentDraft> {
  const out: Record<string, AgentDraft> = {}
  for (const role of CORE_ROLES) out[role] = emptyAgent()
  for (const a of initial?.agents ?? []) {
    const d = out[a.role] ?? emptyAgent()
    if (a.model?.providerId) d.providerId = a.model.providerId
    if (a.model?.modelId) d.modelId = a.model.modelId
    for (const tl of a.tools ?? []) if ((TOOL_PALETTE as readonly string[]).includes(tl)) d.tools.add(tl as ToolId)
    for (const sk of a.skills ?? []) if ((CURATED_SKILLS as readonly string[]).includes(sk)) d.skills.add(sk as CuratedSkill)
    out[a.role] = d
  }
  return out
}

/**
 * WorkflowBuilder (F2 builder UI) — compose/edit a typed, versioned preset:
 *  - enable core agents + per-agent provider/model (from GET /api/providers),
 *  - per-agent tools, with GATE_TOOLS locked to their owner role (tighten-only),
 *  - a curated skill list per agent (not free text),
 *  - the gate policy: the 4 structural gates render LOCKED/enforced; only
 *    requireCriticResolution is an ON-only toggle (it can tighten, never loosen),
 *  - an iterate-budget stepper clamped to 1..3 by clampIterateBudget,
 *  - a RAG toggle.
 * It validates the draft client-side via validateWorkflowDraft BEFORE POSTing, and
 * surfaces the backend's 400 (the source of truth) without swallowing it.
 */
export function WorkflowBuilder({
  api,
  initial,
  onSaved,
}: {
  api: ApiClient
  initial?: WorkflowConfig | WorkflowConfigInput
  onSaved?: (saved: WorkflowConfig) => void
}) {
  const { t } = useI18n()
  const [providers, setProviders] = useState<ProviderInfo[] | undefined>()
  const [name, setName] = useState(initial?.name ?? '')
  const [agents, setAgents] = useState<Record<string, AgentDraft>>(() => hydrate(initial))
  const [requireCritic, setRequireCritic] = useState(initial?.gatePolicy?.requireCriticResolution === true)
  const [iterateBudget, setIterateBudget] = useState(clampIterateBudget(initial?.iterateBudget ?? 1))
  const [rag, setRag] = useState(initial?.rag === true)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<string[]>([])

  useEffect(() => { void api.listProviders().then(setProviders).catch(() => setProviders([])) }, [api])

  const available = useMemo(() => providers ?? [], [providers])
  // The injected provider catalog the pure validator checks the draft against.
  const catalog = useMemo<DraftCatalogProvider[]>(
    () => available.map(p => ({ id: p.id, models: p.models.map(m => ({ id: m.id })) })),
    [available],
  )

  const clearStatus = (): void => { setSaved(false); setErrors([]) }

  const setProvider = (role: string, providerId: string): void => {
    const p = available.find(x => x.id === providerId)
    setAgents(a => ({ ...a, [role]: { ...a[role]!, providerId, modelId: p?.defaultModel ?? '' } }))
    clearStatus()
  }
  const setModel = (role: string, modelId: string): void => {
    setAgents(a => ({ ...a, [role]: { ...a[role]!, modelId } }))
    clearStatus()
  }
  const toggleTool = (role: string, tool: ToolId): void => {
    if (!isGateAllowedForRole(role, tool)) return // tighten-only: never grant a gate tool to a non-owner
    setAgents(a => {
      const next = new Set(a[role]!.tools)
      next.has(tool) ? next.delete(tool) : next.add(tool)
      return { ...a, [role]: { ...a[role]!, tools: next } }
    })
    clearStatus()
  }
  const toggleSkill = (role: string, skill: CuratedSkill): void => {
    setAgents(a => {
      const next = new Set(a[role]!.skills)
      next.has(skill) ? next.delete(skill) : next.add(skill)
      return { ...a, [role]: { ...a[role]!, skills: next } }
    })
    clearStatus()
  }
  const stepBudget = (delta: number): void => { setIterateBudget(b => clampIterateBudget(b + delta)); clearStatus() }

  /** Assemble the WorkflowConfigInput payload from the current draft. */
  const buildDraft = (): WorkflowConfigInput => {
    const agentConfigs: AgentConfig[] = CORE_ROLES.map((role: Role) => {
      const d = agents[role]!
      const cfg: AgentConfig = { role }
      if (d.providerId) cfg.model = d.modelId ? { providerId: d.providerId, modelId: d.modelId } : { providerId: d.providerId }
      // Defensive: only persist gate tools the role actually owns (mirrors the guard).
      const tools = [...d.tools].filter(tl => isGateAllowedForRole(role, tl))
      if (tools.length) cfg.tools = tools
      if (d.skills.size) cfg.skills = [...d.skills]
      return cfg
    })
    const draft: WorkflowConfigInput = {
      name: name.trim(),
      agents: agentConfigs,
      iterateBudget: clampIterateBudget(iterateBudget),
      rag,
      gatePolicy: { requireCriticResolution: requireCritic },
    }
    if (initial?.id) draft.id = initial.id
    return draft
  }

  const save = async (): Promise<void> => {
    clearStatus()
    const draft = buildDraft()
    const local = validateWorkflowDraft(draft, catalog)
    if (!local.ok) { setErrors(local.errors); return }
    setBusy(true)
    try {
      const result = await api.saveWorkflow(draft)
      setSaved(true)
      onSaved?.(result)
    } catch (e) {
      // Surface the backend 400 (source of truth) — never swallow it. Prefer the
      // field-level validation list (validateWorkflowConfig) over the generic message.
      if (ApiError.is(e)) setErrors(e.errors && e.errors.length > 0 ? e.errors : [e.message])
      else setErrors([String(e)])
    } finally {
      setBusy(false)
    }
  }

  if (!providers) return <p className="text-slate-500">{t('workflows.builder.loadingProviders')}</p>

  return (
    <div className="space-y-6">
      <SectionTitle sub={t('workflows.sub')}>
        {initial?.id ? t('workflows.builder.editTitle') : t('workflows.builder.newTitle')}
      </SectionTitle>

      <Card className="p-5">
        <Field label={t('workflows.builder.name')}>
          <Input
            aria-label={t('workflows.builder.name')}
            placeholder={t('workflows.builder.namePlaceholder')}
            value={name}
            onChange={e => { setName(e.target.value); clearStatus() }}
          />
        </Field>
      </Card>

      <Card className="p-5">
        <h3 className="mb-1 text-sm font-semibold uppercase tracking-wider text-slate-300">{t('workflows.builder.agents')}</h3>
        <p className="mb-4 text-xs text-slate-500">{t('workflows.builder.agentsHint')}</p>
        <div className="space-y-4">
          {CORE_ROLES.map(role => {
            const d = agents[role]!
            const provider = available.find(p => p.id === d.providerId)
            return (
              <div key={role} className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
                <div className="mb-3 flex items-center justify-between">
                  <span className="font-semibold text-slate-100">{role}</span>
                  <span className="text-xs text-slate-500">{t(`role.${role}.what`)}</span>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <Field label={t('workflows.builder.provider')}>
                    <select
                      aria-label={`${role}-provider`}
                      className="w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-slate-100"
                      value={d.providerId}
                      onChange={e => setProvider(role, e.target.value)}
                    >
                      <option value="">{t('workflows.builder.default')}</option>
                      {available.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                    </select>
                  </Field>
                  <Field label={t('workflows.builder.model')}>
                    <select
                      aria-label={`${role}-model`}
                      className="w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-slate-100"
                      value={d.modelId}
                      disabled={!provider}
                      onChange={e => setModel(role, e.target.value)}
                    >
                      <option value="">{t('workflows.builder.default')}</option>
                      {provider?.models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                    </select>
                  </Field>
                </div>

                <div className="mt-3">
                  <span className="mb-1 block text-xs font-medium uppercase tracking-wider text-slate-400">{t('workflows.builder.tools')}</span>
                  <div className="flex flex-wrap gap-x-4 gap-y-2">
                    {TOOL_PALETTE.map(tool => {
                      const allowed = isGateAllowedForRole(role, tool)
                      return (
                        <label key={tool} className={`flex items-center gap-2 text-sm ${allowed ? 'text-slate-200' : 'text-slate-600'}`}>
                          <input
                            type="checkbox"
                            aria-label={`${role}-tool-${tool}`}
                            disabled={!allowed}
                            checked={d.tools.has(tool)}
                            onChange={() => toggleTool(role, tool)}
                          />
                          <span>{tool}</span>
                          {!allowed && <span className="text-[10px] uppercase tracking-wider text-slate-600">{t('workflows.builder.locked')}</span>}
                        </label>
                      )
                    })}
                  </div>
                  <span className="mt-1 block text-[11px] text-slate-600">{t('workflows.builder.gateToolLocked')}</span>
                </div>

                <div className="mt-3">
                  <span className="mb-1 block text-xs font-medium uppercase tracking-wider text-slate-400">{t('workflows.builder.skills')}</span>
                  <div className="flex flex-wrap gap-x-4 gap-y-2">
                    {CURATED_SKILLS.map(skill => (
                      <label key={skill} className="flex items-center gap-2 text-sm text-slate-200">
                        <input
                          type="checkbox"
                          aria-label={`${role}-skill-${skill}`}
                          checked={d.skills.has(skill)}
                          onChange={() => toggleSkill(role, skill)}
                        />
                        <span>{skill}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </Card>

      <Card className="p-5">
        <h3 className="mb-1 text-sm font-semibold uppercase tracking-wider text-slate-300">{t('workflows.builder.gatePolicy')}</h3>
        <p className="mb-4 text-xs text-slate-500">{t('workflows.builder.gatePolicyHint')}</p>
        <ul className="space-y-2">
          {STRUCTURAL_GATES.map(gate => {
            const isCritic = gate === 'critic_resolution'
            return (
              <li
                key={gate}
                data-testid={`gate-policy-${gate}`}
                className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2"
              >
                <span className="text-sm font-medium text-slate-100">{t(`workflows.gate.${gate}`)}</span>
                {isCritic ? (
                  <label className="flex items-center gap-2 text-sm text-slate-300">
                    <input
                      type="checkbox"
                      aria-label="require-critic-resolution"
                      checked={requireCritic}
                      onChange={e => { setRequireCritic(e.target.checked); clearStatus() }}
                    />
                    <span>{t('workflows.builder.requireCritic')}</span>
                  </label>
                ) : (
                  <span className="rounded-full bg-white/[0.06] px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                    {t('workflows.builder.locked')}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
        <p className="mt-2 text-[11px] text-slate-600">{t('workflows.builder.requireCriticHint')}</p>
      </Card>

      <Card className="p-5">
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <div>
            <span className="mb-1 block text-xs font-medium uppercase tracking-wider text-slate-400">{t('workflows.builder.iterateBudget')}</span>
            <div className="flex items-center gap-3">
              <Button variant="ghost" aria-label="iterate-budget-decrement" onClick={() => stepBudget(-1)} disabled={iterateBudget <= 1}>−</Button>
              <span data-testid="iterate-budget-value" className="min-w-[2ch] text-center text-lg font-bold text-slate-100">{iterateBudget}</span>
              <Button variant="ghost" aria-label="iterate-budget-increment" onClick={() => stepBudget(1)} disabled={iterateBudget >= 3}>+</Button>
            </div>
            <span className="mt-1 block text-[11px] text-slate-600">{t('workflows.builder.iterateBudgetHint')}</span>
          </div>

          <div>
            <span className="mb-1 block text-xs font-medium uppercase tracking-wider text-slate-400">{t('workflows.builder.rag')}</span>
            <label className="flex items-center gap-2 text-sm text-slate-200">
              <input type="checkbox" aria-label="toggle-rag" checked={rag} onChange={e => { setRag(e.target.checked); clearStatus() }} />
              <span>{rag ? t('workflows.preview.on') : t('workflows.preview.off')}</span>
            </label>
            <span className="mt-1 block text-[11px] text-slate-600">{t('workflows.builder.ragHint')}</span>
          </div>
        </div>
      </Card>

      {errors.length > 0 && (
        <ErrorNote>
          <div className="font-semibold">{t('workflows.builder.invalid')}</div>
          <ul className="mt-1 list-disc pl-5">
            {errors.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        </ErrorNote>
      )}

      <div className="flex items-center gap-3">
        <Button onClick={() => void save()} disabled={busy}>
          {busy ? t('workflows.builder.saving') : t('workflows.builder.save')}
        </Button>
        {saved && <span className="text-sm text-emerald-300">{t('workflows.builder.saved')}</span>}
      </div>
    </div>
  )
}
