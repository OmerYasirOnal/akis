import type { WorkflowConfig, WorkflowConfigInput } from '@akis/shared'
import { Card, SectionTitle } from '../ui/kit.js'
import { useI18n } from '../i18n/I18nContext.js'
import type { StringKey } from '../i18n/catalog.js'
import { applyGatePolicy, type StructuralGate } from './gatePolicy.js'

/** The gate-label i18n key for each structural gate (typed so a missing key fails tsc). */
const GATE_LABEL: Record<StructuralGate, StringKey> = {
  spec_approval: 'workflows.gate.spec_approval',
  real_test_verification: 'workflows.gate.real_test_verification',
  push_confirm: 'workflows.gate.push_confirm',
  critic_resolution: 'workflows.gate.critic_resolution',
}

/**
 * Read-only preview of a workflow draft (F2 builder UI). It renders the FOUR structural
 * gates exactly as a seeded run will honor them — every gate ENFORCED, none removable —
 * proving the preset cannot bypass verification. `applyGatePolicy` is the single source
 * of truth for the tighten-only resolution (critic resolution can be made *required*,
 * but never disabled). Below the gates is a config summary (agents/models/budget/RAG).
 */
export function WorkflowPreview({ draft }: { draft: WorkflowConfig | WorkflowConfigInput }) {
  const { t } = useI18n()
  const gates = applyGatePolicy(draft.gatePolicy)

  return (
    <div className="space-y-6">
      <SectionTitle sub={t('workflows.preview.gatesHint')}>{t('workflows.preview.title')}</SectionTitle>

      <Card className="p-5">
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-300">{t('workflows.preview.gates')}</h3>
        <ul className="space-y-2">
          {gates.map(g => (
            <li
              key={g.id}
              data-testid={`gate-${g.id}`}
              className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2"
            >
              <span className="text-sm font-medium text-slate-100">{t(GATE_LABEL[g.id])}</span>
              <span className="flex items-center gap-2">
                <span className="text-[11px] uppercase tracking-widest text-slate-400">
                  {g.required ? t('workflows.preview.required') : t('workflows.preview.advisory')}
                </span>
                <span
                  data-testid="gate-enforced"
                  className="rounded-full bg-[#07D1AF]/15 px-2.5 py-0.5 text-[11px] font-semibold text-[#07D1AF]"
                >
                  {t('workflows.builder.enforced')}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </Card>

      <Card className="p-5">
        <div data-testid="preview-summary">
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-300">{t('workflows.preview.summary')}</h3>
        <ul className="space-y-2">
          {draft.agents.map(a => (
            <li key={a.role} className="flex items-center justify-between text-sm">
              <span className="font-medium text-slate-200">{a.role}</span>
              <span className="text-slate-400">
                {a.model?.modelId ?? a.model?.providerId ?? t('workflows.builder.default')}
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
          <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2">
            <span className="text-slate-400">{t('workflows.preview.budget')}</span>
            <span data-testid="summary-budget" className="font-semibold text-slate-100">{draft.iterateBudget ?? 1}</span>
          </div>
          <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2">
            <span className="text-slate-400">{t('workflows.preview.rag')}</span>
            <span data-testid="summary-rag" className="font-semibold text-slate-100">
              {draft.rag ? t('workflows.preview.on') : t('workflows.preview.off')}
            </span>
          </div>
        </div>
        </div>
      </Card>
    </div>
  )
}
