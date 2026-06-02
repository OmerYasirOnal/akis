import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { WorkflowConfigInput } from '@akis/shared'
import { WorkflowPreview } from './WorkflowPreview.js'
import { I18nProvider } from '../i18n/I18nContext.js'

const wrap = (ui: ReactNode) => <I18nProvider>{ui}</I18nProvider>

/** A minimal one-agent preset; gatePolicy left off so we prove the gates are still enforced. */
const MINIMAL: WorkflowConfigInput = { name: 'Minimal', agents: [{ role: 'proto' }] }

describe('WorkflowPreview', () => {
  it('renders all FOUR structural gates as enforced for a minimal one-agent preset', () => {
    render(wrap(<WorkflowPreview draft={MINIMAL} />))
    // Each structural gate label is shown (EN copy from the workflows.gate.* catalogue).
    expect(screen.getByText('Spec approval')).toBeInTheDocument()
    expect(screen.getByText('Real-test verification')).toBeInTheDocument()
    expect(screen.getByText('Push confirmation')).toBeInTheDocument()
    expect(screen.getByText('Critic resolution')).toBeInTheDocument()
    // Every gate row is marked enforced — the preset cannot bypass them.
    const enforced = screen.getAllByTestId('gate-enforced')
    expect(enforced).toHaveLength(4)
    for (const el of enforced) expect(el).toHaveTextContent('Enforced')
  })

  it('still shows the critic-resolution gate as structural even when requireCriticResolution=false', () => {
    const draft: WorkflowConfigInput = { ...MINIMAL, gatePolicy: { requireCriticResolution: false } }
    render(wrap(<WorkflowPreview draft={draft} />))
    // The gate cannot be loosened away: it is still listed AND still enforced.
    const row = screen.getByTestId('gate-critic_resolution')
    expect(within(row).getByText('Critic resolution')).toBeInTheDocument()
    expect(within(row).getByTestId('gate-enforced')).toHaveTextContent('Enforced')
    // With the tighten-only lever OFF it is advisory (not required), but still enforced.
    expect(within(row).getByText('Advisory')).toBeInTheDocument()
    // It can never disappear: all 4 gates are present.
    expect(screen.getAllByTestId('gate-enforced')).toHaveLength(4)
  })

  it('marks critic resolution Required when requireCriticResolution=true (tighten)', () => {
    const draft: WorkflowConfigInput = { ...MINIMAL, gatePolicy: { requireCriticResolution: true } }
    render(wrap(<WorkflowPreview draft={draft} />))
    const row = screen.getByTestId('gate-critic_resolution')
    expect(within(row).getByText('Required')).toBeInTheDocument()
  })

  it('renders a read-only summary of enabled agents, per-agent model, iterate budget, and RAG', () => {
    const draft: WorkflowConfigInput = {
      name: 'Full',
      agents: [
        { role: 'proto', model: { providerId: 'anthropic', modelId: 'claude-opus-4-8' } },
        { role: 'trace' },
      ],
      iterateBudget: 2,
      rag: true,
    }
    render(wrap(<WorkflowPreview draft={draft} />))
    const summary = screen.getByTestId('preview-summary')
    // Enabled agents are listed.
    expect(within(summary).getByText('proto')).toBeInTheDocument()
    expect(within(summary).getByText('trace')).toBeInTheDocument()
    // Per-agent model surfaces.
    expect(within(summary).getByText(/claude-opus-4-8/)).toBeInTheDocument()
    // Iterate budget value.
    expect(within(summary).getByTestId('summary-budget')).toHaveTextContent('2')
    // RAG on.
    expect(within(summary).getByTestId('summary-rag')).toHaveTextContent('On')
  })

  it('shows RAG Off when rag is not set', () => {
    render(wrap(<WorkflowPreview draft={MINIMAL} />))
    expect(screen.getByTestId('summary-rag')).toHaveTextContent('Off')
  })
})
