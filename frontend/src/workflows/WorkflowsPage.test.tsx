import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import type { WorkflowConfig, WorkflowConfigInput } from '@akis/shared'
import { WorkflowsPage } from './WorkflowsPage.js'
import { I18nProvider } from '../i18n/I18nContext.js'
import { ApiClient, type ProviderInfo } from '../api/client.js'

const PROVIDERS: ProviderInfo[] = [
  {
    id: 'anthropic', label: 'Anthropic (Claude)', available: true,
    defaultModel: 'claude-haiku-4-5-20251001',
    models: [{ id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' }, { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' }],
  },
]

function wf(id: string, version: number, name: string): WorkflowConfig {
  return { id, version, name, agents: [{ role: 'proto' }] }
}

/** A fake ApiClient covering the three routes the page touches: GET /api/workflows,
 *  GET /api/providers, and POST /api/workflows. `list` is mutable so a save can show up
 *  in a subsequent list fetch (proving the page refreshes after saving). */
function apiWith(opts: { list: WorkflowConfig[]; save?: (body: WorkflowConfigInput) => void } = { list: [] }): ApiClient {
  const fetchFn = vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/api/providers')) {
      return { ok: true, status: 200, json: async () => PROVIDERS, text: async () => '' } as unknown as Response
    }
    if (path.endsWith('/api/workflows') && init?.method === 'POST') {
      const body = JSON.parse(init.body as string) as WorkflowConfigInput
      opts.save?.(body)
      const saved: WorkflowConfig = { ...body, id: body.id ?? 'w-new', version: 1, agents: body.agents }
      opts.list.push(saved)
      return { ok: true, status: 201, json: async () => saved, text: async () => '' } as unknown as Response
    }
    if (path.endsWith('/api/workflows')) {
      return { ok: true, status: 200, json: async () => opts.list, text: async () => '' } as unknown as Response
    }
    // Single-workflow probe (version history) — not exercised here.
    return { ok: false, status: 404, json: async () => ({ error: 'not found', code: 'NotFound' }), text: async () => '' } as unknown as Response
  })
  return new ApiClient('', fetchFn)
}

const wrap = (ui: ReactNode) => <I18nProvider>{ui}</I18nProvider>

describe('WorkflowsPage', () => {
  it('defaults to the list view (saved workflows)', async () => {
    render(wrap(<WorkflowsPage api={apiWith({ list: [wf('a', 2, 'Alpha')] })} />))
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument())
    expect(screen.getByText('Saved workflows')).toBeInTheDocument()
    // The builder is not mounted in the list view.
    expect(screen.queryByLabelText('Workflow name')).not.toBeInTheDocument()
  })

  it('New switches to the builder + live preview, and Back returns to the list', async () => {
    render(wrap(<WorkflowsPage api={apiWith({ list: [] })} />))
    await waitFor(() => expect(screen.getByRole('button', { name: 'New workflow' })).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: 'New workflow' }))

    // Builder is mounted (name field) AND the live preview pane (the structural gates).
    await waitFor(() => expect(screen.getByLabelText('Workflow name')).toBeInTheDocument())
    expect(screen.getByText('Structural gates')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Back to workflows' }))
    await waitFor(() => expect(screen.getByText('Saved workflows')).toBeInTheDocument())
    expect(screen.queryByLabelText('Workflow name')).not.toBeInTheDocument()
  })

  it('Edit opens the builder hydrated with the selected workflow', async () => {
    render(wrap(<WorkflowsPage api={apiWith({ list: [wf('a', 2, 'Alpha')] })} />))
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument())
    await userEvent.click(within(screen.getByTestId('workflow-a')).getByRole('button', { name: 'Edit' }))
    await waitFor(() => expect((screen.getByLabelText('Workflow name') as HTMLInputElement).value).toBe('Alpha'))
  })

  it('the live preview reflects the draft (RAG toggle flips the summary)', async () => {
    render(wrap(<WorkflowsPage api={apiWith({ list: [] })} />))
    await waitFor(() => expect(screen.getByRole('button', { name: 'New workflow' })).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: 'New workflow' }))
    await waitFor(() => expect(screen.getByLabelText('Workflow name')).toBeInTheDocument())

    expect(screen.getByTestId('summary-rag')).toHaveTextContent('Off')
    await userEvent.click(screen.getByLabelText('toggle-rag'))
    await waitFor(() => expect(screen.getByTestId('summary-rag')).toHaveTextContent('On'))
  })

  it('saving in the builder returns to the list and shows the new workflow', async () => {
    const save = vi.fn()
    render(wrap(<WorkflowsPage api={apiWith({ list: [], save })} />))
    await waitFor(() => expect(screen.getByRole('button', { name: 'New workflow' })).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: 'New workflow' }))
    await waitFor(() => expect(screen.getByLabelText('Workflow name')).toBeInTheDocument())

    await userEvent.type(screen.getByLabelText('Workflow name'), 'Fresh preset')
    await userEvent.click(screen.getByRole('button', { name: 'Save workflow' }))

    // After saving the page returns to the list and the new preset is listed.
    await waitFor(() => expect(save).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByText('Saved workflows')).toBeInTheDocument())
    expect(await screen.findByText('Fresh preset')).toBeInTheDocument()
  })
})
