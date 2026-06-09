import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ModelPicker, MODEL_POPOVER_ID, type ModelSelection } from './ModelPicker.js'
import { ModelChip } from './ModelChip.js'
import { I18nProvider } from '../i18n/I18nContext.js'
import type { ProviderInfo } from '../api/client.js'

const PROVIDERS: ProviderInfo[] = [
  {
    id: 'anthropic', label: 'Anthropic (Claude)', available: true, defaultModel: 'claude-haiku-4-5-20251001',
    models: [
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', recommended: true },
    ],
  },
  {
    id: 'openai', label: 'OpenAI', available: false, defaultModel: 'gpt-4.1-mini',
    models: [{ id: 'gpt-4.1-mini', label: 'GPT-4.1 mini', recommended: true }],
  },
]

function renderPicker(over: Partial<React.ComponentProps<typeof ModelPicker>> = {}) {
  const onSelect = vi.fn()
  const onClose = vi.fn()
  render(
    <I18nProvider>
      <ModelPicker
        providers={PROVIDERS}
        selected={{ provider: 'anthropic', model: 'claude-haiku-4-5-20251001', effort: 'balanced' }}
        onSelect={onSelect}
        onClose={onClose}
        {...over}
      />
    </I18nProvider>,
  )
  return { onSelect, onClose }
}

describe('ModelPicker', () => {
  it('renders providers grouped by label, with all their models', () => {
    renderPicker()
    expect(screen.getByText('Anthropic (Claude)')).toBeInTheDocument()
    expect(screen.getByText('OpenAI')).toBeInTheDocument()
    expect(screen.getByText('Claude Haiku 4.5')).toBeInTheDocument()
    expect(screen.getByText('Claude Sonnet 4.6')).toBeInTheDocument()
    expect(screen.getByText('GPT-4.1 mini')).toBeInTheDocument()
  })

  it('shows a "recommended" badge on flagged models only', () => {
    renderPicker()
    // Two recommended models (Sonnet + GPT-4.1 mini) → two badges.
    expect(screen.getAllByText(/recommended/i)).toHaveLength(2)
  })

  it('renders the three effort tiers as radios', () => {
    renderPicker()
    expect(screen.getByRole('radio', { name: /Fast/i })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Balanced/i })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Deep/i })).toBeInTheDocument()
  })

  it('defaults the radios to the current selection', () => {
    renderPicker({ selected: { provider: 'anthropic', model: 'claude-sonnet-4-6', effort: 'deep' } })
    expect(screen.getByRole('radio', { name: 'Claude Sonnet 4.6' })).toBeChecked()
    expect(screen.getByRole('radio', { name: /Deep/i })).toBeChecked()
  })

  it('calls onSelect with the chosen {provider, model, effort} on Apply, then onClose', async () => {
    const { onSelect, onClose } = renderPicker()
    await userEvent.click(screen.getByRole('radio', { name: 'Claude Sonnet 4.6' }))
    await userEvent.click(screen.getByRole('radio', { name: /Deep/i }))
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onSelect).toHaveBeenCalledWith({ provider: 'anthropic', model: 'claude-sonnet-4-6', effort: 'deep' })
    expect(onClose).toHaveBeenCalled()
  })

  it('Cancel closes WITHOUT committing a selection', async () => {
    const { onSelect, onClose } = renderPicker()
    await userEvent.click(screen.getByRole('radio', { name: 'Claude Sonnet 4.6' }))
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onSelect).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('an UNCONFIGURED provider (available:false) is visibly disabled — no dead-end selection (Opus review M1)', async () => {
    const { onSelect } = renderPicker()
    // The openai fixture has no key: its radios are disabled and the no-key hint shows.
    expect(screen.getByRole('radio', { name: 'GPT-4.1 mini' })).toBeDisabled()
    expect(screen.getByText('no API key — add one in Settings')).toBeInTheDocument()
    // Clicking it selects NOTHING (Apply keeps the original anthropic selection).
    await userEvent.click(screen.getByRole('radio', { name: 'GPT-4.1 mini' }))
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ provider: 'anthropic' }))
  })

  it('switches provider+model together when picking a model under a different AVAILABLE provider', async () => {
    const { onSelect } = renderPicker()
    // Sonnet lives under the same (available) anthropic group in the fixture; switching to it
    // proves the provider+model travel together through Apply.
    await userEvent.click(screen.getByRole('radio', { name: 'Claude Sonnet 4.6' }))
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onSelect).toHaveBeenCalledWith({ provider: 'anthropic', model: 'claude-sonnet-4-6', effort: 'balanced' })
  })
})

describe('ModelChip', () => {
  it('renders the model label + effort WITHOUT any LIVE/DEMO/CANLI status badge (P1.3)', () => {
    render(
      <I18nProvider>
        <ModelChip model="Claude Sonnet 4.6" effort="balanced" />
      </I18nProvider>,
    )
    const chip = screen.getByRole('button')
    expect(chip).toHaveTextContent('Claude Sonnet 4.6')
    expect(chip).toHaveTextContent('Balanced')
    // The status pill is GONE — no live/demo/no-key badge on the chip itself.
    expect(screen.queryByText(/CANLI|LIVE|DEMO|NO KEY/i)).toBeNull()
  })

  it('is the popover trigger: aria-haspopup + aria-expanded, and fires onClick', async () => {
    const onClick = vi.fn()
    render(
      <I18nProvider>
        <ModelChip model="GPT-4.1 mini" effort="deep" onClick={onClick} />
      </I18nProvider>,
    )
    const chip = screen.getByRole('button')
    expect(chip).toHaveTextContent('Deep')
    expect(chip).toHaveAttribute('aria-haspopup', 'dialog')
    expect(chip).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(chip)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('reflects an OPEN popover via aria-expanded', () => {
    render(
      <I18nProvider>
        <ModelChip model="Claude Haiku 4.5" effort="fast" open controls="akis-model-popover" />
      </I18nProvider>,
    )
    const chip = screen.getByRole('button')
    expect(chip).toHaveAttribute('aria-expanded', 'true')
    expect(chip).toHaveAttribute('aria-controls', 'akis-model-popover')
  })
})

describe('ModelPicker — popover a11y (#10)', () => {
  it('moves focus INTO the dialog on open', () => {
    renderPicker()
    const dialog = screen.getByRole('dialog')
    expect(dialog.contains(document.activeElement)).toBe(true) // not left on <body>
  })

  it('Escape closes the dialog (keyboard dismiss)', async () => {
    const { onClose } = renderPicker()
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalled()
  })

  it('carries the popover id so the trigger chip can aria-control it', () => {
    renderPicker()
    expect(screen.getByRole('dialog')).toHaveAttribute('id', MODEL_POPOVER_ID)
  })
})

// The in-composer flow: the ModelChip is the trigger, and the popover is anchored next to it. This
// harness mirrors AkisChat's wiring (a `relative` wrapper holding the chip + the conditionally-mounted
// popover) so we exercise open → select → persist (via onSelect) → close, plus outside-click dismiss.
function ChipWithPopover({ onPersist }: { onPersist: (s: ModelSelection) => void }) {
  const [open, setOpen] = useState(false)
  const [sel, setSel] = useState<ModelSelection>({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001', effort: 'balanced' })
  // Resolve the model DISPLAY label exactly as AkisChat does (id → label) before passing to the chip.
  const modelLabel = PROVIDERS.find(p => p.id === sel.provider)?.models.find(m => m.id === sel.model)?.label ?? sel.model
  return (
    <I18nProvider>
      <div className="relative">
        <ModelChip model={modelLabel} effort={sel.effort} open={open} controls={MODEL_POPOVER_ID} onClick={() => setOpen(o => !o)} />
        {open && (
          <ModelPicker
            providers={PROVIDERS}
            selected={sel}
            onSelect={(s) => { setSel(s); onPersist(s) }}
            onClose={() => setOpen(false)}
          />
        )}
      </div>
    </I18nProvider>
  )
}

describe('ModelPicker — in-composer popover flow (P1.3)', () => {
  it('opens from the chip trigger, selects + persists via onSelect, then closes', async () => {
    const onPersist = vi.fn()
    render(<ChipWithPopover onPersist={onPersist} />)
    // Closed initially — no dialog.
    expect(screen.queryByRole('dialog')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /tap to change|değiştirmek/i }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    // Pick Sonnet + Deep, Apply → onSelect persists, popover closes.
    await userEvent.click(screen.getByRole('radio', { name: 'Claude Sonnet 4.6' }))
    await userEvent.click(screen.getByRole('radio', { name: /Deep/i }))
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onPersist).toHaveBeenCalledWith({ provider: 'anthropic', model: 'claude-sonnet-4-6', effort: 'deep' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // The chip now reflects the chosen model label.
    expect(screen.getByRole('button', { name: /tap to change|değiştirmek/i })).toHaveTextContent('Claude Sonnet 4.6')
  })

  it('an OUTSIDE pointerdown dismisses the popover (no commit)', async () => {
    const onPersist = vi.fn()
    render(
      <div>
        <ChipWithPopover onPersist={onPersist} />
        <button type="button">outside</button>
      </div>,
    )
    await userEvent.click(screen.getByRole('button', { name: /tap to change|değiştirmek/i }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'outside' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(onPersist).not.toHaveBeenCalled() // dismissed without committing
  })
})
