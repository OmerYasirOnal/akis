import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ModelPicker } from './ModelPicker.js'
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
  it('shows provider · model · effort and a LIVE badge in live mode', () => {
    render(
      <I18nProvider>
        <ModelChip provider="Anthropic (Claude)" model="Claude Sonnet 4.6" effort="balanced" mode="live" />
      </I18nProvider>,
    )
    const chip = screen.getByRole('button')
    expect(chip).toHaveTextContent('Anthropic (Claude)')
    expect(chip).toHaveTextContent('Claude Sonnet 4.6')
    expect(chip).toHaveTextContent('Balanced')
    expect(chip).toHaveTextContent('LIVE')
    expect(chip).not.toHaveTextContent('DEMO')
  })

  it('shows a DEMO badge in demo mode and fires onClick', async () => {
    const onClick = vi.fn()
    render(
      <I18nProvider>
        <ModelChip provider="OpenAI" model="GPT-4.1 mini" effort="deep" mode="demo" onClick={onClick} />
      </I18nProvider>,
    )
    const chip = screen.getByRole('button')
    expect(chip).toHaveTextContent('DEMO')
    expect(chip).toHaveTextContent('Deep')
    await userEvent.click(chip)
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
