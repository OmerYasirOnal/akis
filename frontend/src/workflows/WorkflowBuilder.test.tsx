import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import type { WorkflowConfigInput } from '@akis/shared'
import { WorkflowBuilder } from './WorkflowBuilder.js'
import { I18nProvider } from '../i18n/I18nContext.js'
import { ApiClient, type ProviderInfo } from '../api/client.js'

const PROVIDERS: ProviderInfo[] = [
  {
    id: 'anthropic', label: 'Anthropic (Claude)', available: true,
    defaultModel: 'claude-haiku-4-5-20251001',
    models: [{ id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' }, { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' }],
  },
  {
    id: 'openai', label: 'OpenAI', available: false, defaultModel: 'gpt-4.1-mini',
    models: [{ id: 'gpt-4.1-mini', label: 'GPT-4.1 mini' }],
  },
]

/** Build an ApiClient whose fetch is faked: GET /api/providers returns PROVIDERS; POST
 *  /api/workflows records the body via `save` and either 201s the echoed config or, when
 *  `saveStatus` is 400, returns a validation error envelope (mirrors the real route). */
function apiWith(opts: {
  save?: (body: WorkflowConfigInput) => void
  saveStatus?: number
  saveErrors?: string[]
} = {}): ApiClient {
  const fetchFn = vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/api/providers')) {
      return { ok: true, status: 200, json: async () => PROVIDERS, text: async () => '' } as unknown as Response
    }
    if (path.endsWith('/api/workflows') && init?.method === 'POST') {
      const body = JSON.parse(init.body as string) as WorkflowConfigInput
      opts.save?.(body)
      const status = opts.saveStatus ?? 201
      if (status >= 400) {
        return {
          ok: false, status,
          json: async () => ({ error: 'invalid workflow', code: 'Invalid', errors: opts.saveErrors ?? ['boom'] }),
          text: async () => '',
        } as unknown as Response
      }
      return { ok: true, status: 201, json: async () => ({ ...body, id: 'w1', version: 1 }), text: async () => '' } as unknown as Response
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response
  })
  return new ApiClient('', fetchFn)
}

const wrap = (ui: ReactNode) => <I18nProvider>{ui}</I18nProvider>

async function renderBuilder(api: ApiClient) {
  render(wrap(<WorkflowBuilder api={api} />))
  // Wait until providers have loaded (the name field is the stable anchor).
  await waitFor(() => expect(screen.getByLabelText('Workflow name')).toBeInTheDocument())
}

/** Fill the required name and click Save, returning the recorded payload (or undefined). */
async function fillNameAndSave(name = 'My preset'): Promise<void> {
  await userEvent.clear(screen.getByLabelText('Workflow name'))
  await userEvent.type(screen.getByLabelText('Workflow name'), name)
  await userEvent.click(screen.getByRole('button', { name: 'Save workflow' }))
}

describe('WorkflowBuilder', () => {
  it('renders the core roles with provider/model selects populated from /api/providers', async () => {
    await renderBuilder(apiWith())
    for (const role of ['orchestrator', 'scribe', 'proto', 'trace', 'critic']) {
      expect(screen.getByText(role)).toBeInTheDocument()
      expect(screen.getByLabelText(`${role}-provider`)).toBeInTheDocument()
    }
    // The provider select offers each catalog provider.
    const protoProvider = screen.getByLabelText('proto-provider')
    expect(within(protoProvider).getByRole('option', { name: 'Anthropic (Claude)' })).toBeInTheDocument()
    expect(within(protoProvider).getByRole('option', { name: 'OpenAI' })).toBeInTheDocument()
  })

  it('TIGHTEN-ONLY: the run_tests gate tool is disabled for a non-owner role (proto) and never reaches the payload', async () => {
    const save = vi.fn()
    await renderBuilder(apiWith({ save }))
    // proto is not the owner of run_tests (trace is) → its checkbox must be disabled.
    const protoRunTests = screen.getByLabelText('proto-tool-run_tests') as HTMLInputElement
    expect(protoRunTests).toBeDisabled()
    // Attempting to enable it has no effect (it stays unchecked).
    await userEvent.click(protoRunTests).catch(() => undefined)
    expect(protoRunTests.checked).toBe(false)

    await fillNameAndSave()
    await waitFor(() => expect(save).toHaveBeenCalled())
    const body = save.mock.calls[0]![0] as WorkflowConfigInput
    const proto = body.agents.find(a => a.role === 'proto')
    expect(proto?.tools ?? []).not.toContain('run_tests')
  })

  it('TIGHTEN-ONLY: trace (the owner) CAN hold run_tests and it reaches the payload', async () => {
    const save = vi.fn()
    await renderBuilder(apiWith({ save }))
    const traceRunTests = screen.getByLabelText('trace-tool-run_tests') as HTMLInputElement
    expect(traceRunTests).not.toBeDisabled()
    await userEvent.click(traceRunTests)
    expect(traceRunTests.checked).toBe(true)

    await fillNameAndSave()
    await waitFor(() => expect(save).toHaveBeenCalled())
    const body = save.mock.calls[0]![0] as WorkflowConfigInput
    const trace = body.agents.find(a => a.role === 'trace')
    expect(trace?.tools).toContain('run_tests')
  })

  it('TIGHTEN-ONLY: iterate budget cannot exceed 3 and the saved payload never carries >3 or <1', async () => {
    const save = vi.fn()
    await renderBuilder(apiWith({ save }))
    const inc = screen.getByRole('button', { name: 'iterate-budget-increment' })
    // Click increment many times; the displayed value must clamp at 3.
    for (let i = 0; i < 6; i++) await userEvent.click(inc)
    expect(screen.getByTestId('iterate-budget-value')).toHaveTextContent('3')

    await fillNameAndSave()
    await waitFor(() => expect(save).toHaveBeenCalled())
    const body = save.mock.calls[0]![0] as WorkflowConfigInput
    expect(body.iterateBudget).toBeLessThanOrEqual(3)
    expect(body.iterateBudget).toBeGreaterThanOrEqual(1)
    expect(body.iterateBudget).toBe(3)
  })

  it('iterate budget cannot go below 1', async () => {
    await renderBuilder(apiWith())
    const dec = screen.getByRole('button', { name: 'iterate-budget-decrement' })
    for (let i = 0; i < 6; i++) await userEvent.click(dec)
    expect(screen.getByTestId('iterate-budget-value')).toHaveTextContent('1')
  })

  it('the 4 structural gates are locked/enforced; only requireCriticResolution can be toggled ON', async () => {
    const save = vi.fn()
    await renderBuilder(apiWith({ save }))
    // The 3 non-toggleable gates have no enable/disable control — they render Locked.
    for (const gate of ['spec_approval', 'real_test_verification', 'push_confirm']) {
      const row = screen.getByTestId(`gate-policy-${gate}`)
      expect(within(row).queryByRole('checkbox')).not.toBeInTheDocument()
      expect(within(row).getByText('Locked')).toBeInTheDocument()
    }
    // Only critic_resolution exposes a toggle, and it adds (tightens) the requirement.
    const critic = screen.getByLabelText('require-critic-resolution') as HTMLInputElement
    expect(critic.checked).toBe(false)
    await userEvent.click(critic)
    expect(critic.checked).toBe(true)

    await fillNameAndSave()
    await waitFor(() => expect(save).toHaveBeenCalled())
    const body = save.mock.calls[0]![0] as WorkflowConfigInput
    expect(body.gatePolicy?.requireCriticResolution).toBe(true)
  })

  it('enabling RAG and selecting skills includes rag:true + skills[] in the saved payload', async () => {
    const save = vi.fn()
    await renderBuilder(apiWith({ save }))
    await userEvent.click(screen.getByLabelText('toggle-rag'))
    // Pick a skill on proto (curated FE list, not free text).
    const skill = screen.getByLabelText('proto-skill-frontend')
    await userEvent.click(skill)

    await fillNameAndSave()
    await waitFor(() => expect(save).toHaveBeenCalled())
    const body = save.mock.calls[0]![0] as WorkflowConfigInput
    expect(body.rag).toBe(true)
    const proto = body.agents.find(a => a.role === 'proto')
    expect(proto?.skills).toContain('frontend')
  })

  it('save POSTs a valid WorkflowConfigInput via saveWorkflow and shows the saved confirmation', async () => {
    const save = vi.fn()
    await renderBuilder(apiWith({ save }))
    // Give proto a model so the payload exercises the per-agent model path.
    await userEvent.selectOptions(screen.getByLabelText('proto-provider'), 'anthropic')
    await userEvent.selectOptions(screen.getByLabelText('proto-model'), 'claude-opus-4-8')
    await fillNameAndSave('Shipped preset')

    await waitFor(() => expect(screen.getByText('Workflow saved')).toBeInTheDocument())
    const body = save.mock.calls[0]![0] as WorkflowConfigInput
    expect(body.name).toBe('Shipped preset')
    expect(body.agents.length).toBeGreaterThan(0)
    const proto = body.agents.find(a => a.role === 'proto')
    expect(proto?.model).toEqual({ providerId: 'anthropic', modelId: 'claude-opus-4-8' })
  })

  it('surfaces a backend 400 validation message and does NOT show saved', async () => {
    const api = apiWith({ saveStatus: 400, saveErrors: ["agent 'proto': cannot hold gate capability 'run_tests' (only 'trace' may)"] })
    await renderBuilder(api)
    await fillNameAndSave()
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByRole('alert')).toHaveTextContent("cannot hold gate capability 'run_tests'")
    expect(screen.queryByText('Workflow saved')).not.toBeInTheDocument()
  })

  it('client-side validation blocks a save with an empty name (no POST)', async () => {
    const save = vi.fn()
    await renderBuilder(apiWith({ save }))
    // Name starts empty; clicking save should surface the invalid hint and NOT POST.
    await userEvent.click(screen.getByRole('button', { name: 'Save workflow' }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(save).not.toHaveBeenCalled()
  })

  it('hydrates from an existing workflow for editing and saves a new version under the same id', async () => {
    const save = vi.fn()
    const initial: WorkflowConfigInput = {
      id: 'wf-1', name: 'Existing', rag: true, iterateBudget: 2,
      agents: [{ role: 'proto', model: { providerId: 'anthropic', modelId: 'claude-opus-4-8' }, skills: ['frontend'] }],
      gatePolicy: { requireCriticResolution: true },
    }
    render(wrap(<WorkflowBuilder api={apiWith({ save })} initial={initial} />))
    await waitFor(() => expect((screen.getByLabelText('Workflow name') as HTMLInputElement).value).toBe('Existing'))
    expect((screen.getByLabelText('toggle-rag') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('require-critic-resolution') as HTMLInputElement).checked).toBe(true)

    await userEvent.click(screen.getByRole('button', { name: 'Save workflow' }))
    await waitFor(() => expect(save).toHaveBeenCalled())
    const body = save.mock.calls[0]![0] as WorkflowConfigInput
    expect(body.id).toBe('wf-1') // saving an existing id appends a new version server-side
  })
})
