import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  CORE_ROLES,
  GATE_TOOLS,
  ADVISORY_PHASES,
  isCoreRole,
  type Role,
  type AgentConfig,
  type AdvisoryPhase,
  type WorkflowConfig,
  type WorkflowConfigInput,
} from '@akis/shared'
import { ApiClient, ApiError, type ProviderInfo } from '../api/client.js'
import { Card, SectionTitle, Button, Field, Input, Select, ErrorNote } from '../ui/kit.js'
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

/** The tools a CUSTOM (advisory) agent may be offered. ADVISORY by construction: gate
 *  tools (GATE_TOOLS) are NEVER in this palette, so the UI can't even attempt to grant
 *  one — an advisory agent has zero gate authority (mirrors the backend AgentRegistry,
 *  which rejects any gate capability at registration). `retrieve_knowledge` lets it
 *  ground its (ephemeral) advice in prior project context. */
const ADVISORY_TOOLS = ['retrieve_knowledge', 'chat', 'ask'] as const
type AdvisoryTool = typeof ADVISORY_TOOLS[number]

/** Editable draft for one custom advisory agent. `phase` empty ⇒ dispatched at every edge. */
interface CustomAgentDraft {
  /** Stable client key so editing one row never remounts/loses focus on the others. */
  key: string
  role: string
  phase: '' | AdvisoryPhase
  providerId: string
  modelId: string
  instructions: string
  tools: Set<AdvisoryTool>
}

let customKeySeq = 0
function emptyCustomAgent(): CustomAgentDraft {
  return { key: `ca-${customKeySeq++}`, role: '', phase: '', providerId: '', modelId: '', instructions: '', tools: new Set() }
}

/** Hydrate the custom (non-core) agents of an existing workflow into editable rows. */
function hydrateCustom(initial?: WorkflowConfig | WorkflowConfigInput): CustomAgentDraft[] {
  const out: CustomAgentDraft[] = []
  for (const a of initial?.agents ?? []) {
    if (isCoreRole(a.role)) continue // core roles are handled by the per-role section above
    const d = emptyCustomAgent()
    d.role = a.role
    if (a.phase) d.phase = a.phase
    if (a.model?.providerId) d.providerId = a.model.providerId
    if (a.model?.modelId) d.modelId = a.model.modelId
    if (a.basePromptVariant) d.instructions = a.basePromptVariant
    for (const tl of a.tools ?? []) if ((ADVISORY_TOOLS as readonly string[]).includes(tl)) d.tools.add(tl as AdvisoryTool)
    out.push(d)
  }
  return out
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
  onDraftChange,
}: {
  api: ApiClient
  initial?: WorkflowConfig | WorkflowConfigInput
  onSaved?: (saved: WorkflowConfig) => void
  /** Fires with the assembled WorkflowConfigInput whenever the draft changes, so a parent
   *  can render a LIVE preview alongside the builder. Optional — the builder works standalone. */
  onDraftChange?: (draft: WorkflowConfigInput) => void
}) {
  const { t } = useI18n()
  const [providers, setProviders] = useState<ProviderInfo[] | undefined>()
  const [name, setName] = useState(initial?.name ?? '')
  const [agents, setAgents] = useState<Record<string, AgentDraft>>(() => hydrate(initial))
  const [customAgents, setCustomAgents] = useState<CustomAgentDraft[]>(() => hydrateCustom(initial))
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

  // ── Custom (advisory) agent handlers ──────────────────────────────────────────────
  const addCustomAgent = (): void => { setCustomAgents(list => [...list, emptyCustomAgent()]); clearStatus() }
  const removeCustomAgent = (key: string): void => { setCustomAgents(list => list.filter(c => c.key !== key)); clearStatus() }
  const updateCustomAgent = (key: string, patch: Partial<CustomAgentDraft>): void => {
    setCustomAgents(list => list.map(c => (c.key === key ? { ...c, ...patch } : c)))
    clearStatus()
  }
  const setCustomProvider = (key: string, providerId: string): void => {
    const p = available.find(x => x.id === providerId)
    updateCustomAgent(key, { providerId, modelId: p?.defaultModel ?? '' })
  }
  const toggleCustomTool = (key: string, tool: AdvisoryTool): void => {
    setCustomAgents(list => list.map(c => {
      if (c.key !== key) return c
      const next = new Set(c.tools)
      next.has(tool) ? next.delete(tool) : next.add(tool)
      return { ...c, tools: next }
    }))
    clearStatus()
  }

  /** Assemble the WorkflowConfigInput payload from the current draft. */
  const buildDraft = useCallback((): WorkflowConfigInput => {
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

    // Custom (advisory) agents: appended as NON-core AgentConfigs. The backend's
    // workflowCustomAgents() picks these out and wires them as LlmAdvisoryAgents — they
    // hold only non-gate tools, run at the edges, and their notes are ephemeral. An
    // unnamed/incomplete row (or one that collides with a core role) is dropped, never POSTed.
    for (const c of customAgents) {
      const role = c.role.trim()
      if (!role || isCoreRole(role)) continue
      const cfg: AgentConfig = { role }
      if (c.providerId) cfg.model = c.modelId ? { providerId: c.providerId, modelId: c.modelId } : { providerId: c.providerId }
      // ADVISORY tools only — gate tools are not even in the palette, so none can appear here.
      const tools = [...c.tools]
      if (tools.length) cfg.tools = tools
      if (c.instructions.trim()) cfg.basePromptVariant = c.instructions.trim()
      if (c.phase) cfg.phase = c.phase
      agentConfigs.push(cfg)
    }

    const draft: WorkflowConfigInput = {
      name: name.trim(),
      agents: agentConfigs,
      iterateBudget: clampIterateBudget(iterateBudget),
      rag,
      gatePolicy: { requireCriticResolution: requireCritic },
    }
    if (initial?.id) draft.id = initial.id
    return draft
  }, [agents, customAgents, name, iterateBudget, rag, requireCritic, initial?.id])

  // Push the live draft up so a parent can render a real-time preview beside the builder.
  useEffect(() => { onDraftChange?.(buildDraft()) }, [buildDraft, onDraftChange])

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
                    <Select
                      aria-label={`${role}-provider`}
                      className="text-sm"
                      value={d.providerId}
                      onChange={e => setProvider(role, e.target.value)}
                    >
                      <option value="">{t('workflows.builder.default')}</option>
                      {available.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                    </Select>
                  </Field>
                  <Field label={t('workflows.builder.model')}>
                    <Select
                      aria-label={`${role}-model`}
                      className="text-sm"
                      value={d.modelId}
                      disabled={!provider}
                      onChange={e => setModel(role, e.target.value)}
                    >
                      <option value="">{t('workflows.builder.default')}</option>
                      {provider?.models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                    </Select>
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
        <div className="mb-1 flex items-center gap-2">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-300">{t('workflows.builder.customAgents')}</h3>
          <span className="rounded-full bg-[#07D1AF]/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[#07D1AF]">
            {t('workflows.builder.advisoryBadge')}
          </span>
        </div>
        <p className="mb-4 text-xs text-slate-500">{t('workflows.builder.customAgentsHint')}</p>

        {customAgents.length === 0 && (
          <p data-testid="custom-agents-empty" className="mb-4 text-xs text-slate-600">{t('workflows.builder.customAgentsEmpty')}</p>
        )}

        <div className="space-y-4">
          {customAgents.map((c, idx) => {
            const provider = available.find(p => p.id === c.providerId)
            return (
              <div key={c.key} data-testid={`custom-agent-${idx}`} className="rounded-xl border border-[#07D1AF]/15 bg-[#07D1AF]/[0.03] p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <Input
                    aria-label={`custom-agent-${idx}-name`}
                    placeholder={t('workflows.builder.customAgentNamePlaceholder')}
                    value={c.role}
                    onChange={e => updateCustomAgent(c.key, { role: e.target.value })}
                  />
                  <Button variant="ghost" aria-label={`custom-agent-${idx}-remove`} onClick={() => removeCustomAgent(c.key)}>
                    {t('workflows.builder.customAgentRemove')}
                  </Button>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <Field label={t('workflows.builder.customAgentEdge')}>
                    <Select
                      aria-label={`custom-agent-${idx}-edge`}
                      className="text-sm"
                      value={c.phase}
                      onChange={e => updateCustomAgent(c.key, { phase: e.target.value as '' | AdvisoryPhase })}
                    >
                      <option value="">{t('workflows.builder.customAgentEdgeEvery')}</option>
                      {ADVISORY_PHASES.map(p => <option key={p} value={p}>{t(`workflows.edge.${p}`)}</option>)}
                    </Select>
                  </Field>
                  <Field label={t('workflows.builder.provider')}>
                    <Select
                      aria-label={`custom-agent-${idx}-provider`}
                      className="text-sm"
                      value={c.providerId}
                      onChange={e => setCustomProvider(c.key, e.target.value)}
                    >
                      <option value="">{t('workflows.builder.default')}</option>
                      {available.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                    </Select>
                  </Field>
                  <Field label={t('workflows.builder.model')}>
                    <Select
                      aria-label={`custom-agent-${idx}-model`}
                      className="text-sm"
                      value={c.modelId}
                      disabled={!provider}
                      onChange={e => updateCustomAgent(c.key, { modelId: e.target.value })}
                    >
                      <option value="">{t('workflows.builder.default')}</option>
                      {provider?.models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                    </Select>
                  </Field>
                </div>

                <div className="mt-3">
                  <span className="mb-1 block text-xs font-medium uppercase tracking-wider text-slate-400">{t('workflows.builder.customAgentInstructions')}</span>
                  <textarea
                    aria-label={`custom-agent-${idx}-instructions`}
                    rows={2}
                    placeholder={t('workflows.builder.customAgentInstructionsPlaceholder')}
                    className="w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-[#07D1AF] focus:outline-none focus:ring-1 focus:ring-[#07D1AF]/40"
                    value={c.instructions}
                    onChange={e => updateCustomAgent(c.key, { instructions: e.target.value })}
                  />
                </div>

                <div className="mt-3">
                  <span className="mb-1 block text-xs font-medium uppercase tracking-wider text-slate-400">{t('workflows.builder.tools')}</span>
                  <div className="flex flex-wrap gap-x-4 gap-y-2">
                    {ADVISORY_TOOLS.map(tool => (
                      <label key={tool} className="flex items-center gap-2 text-sm text-slate-200">
                        <input
                          type="checkbox"
                          aria-label={`custom-agent-${idx}-tool-${tool}`}
                          checked={c.tools.has(tool)}
                          onChange={() => toggleCustomTool(c.key, tool)}
                        />
                        <span>{tool}</span>
                      </label>
                    ))}
                  </div>
                  <span className="mt-1 block text-[11px] text-slate-600">{t('workflows.builder.customAgentToolsHint')}</span>
                </div>
              </div>
            )
          })}
        </div>

        <Button variant="ghost" className="mt-4" aria-label="add-custom-agent" onClick={addCustomAgent}>
          {t('workflows.builder.customAgentAdd')}
        </Button>
        <p className="mt-3 text-[11px] text-[#07D1AF]/80">{t('workflows.builder.customAgentNoGate')}</p>
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
