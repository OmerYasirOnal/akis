import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import type { WorkflowConfig } from '@akis/shared'
import { WorkflowList } from './WorkflowList.js'
import { I18nProvider } from '../i18n/I18nContext.js'
import { ApiClient } from '../api/client.js'

const wrap = (ui: ReactNode) => <I18nProvider>{ui}</I18nProvider>

function wf(id: string, version: number, name: string): WorkflowConfig {
  return { id, version, name, agents: [{ role: 'proto' }] }
}

/** A fake ApiClient: GET /api/workflows returns `list`; GET /api/workflows/:id?version=N
 *  returns the version from `byVersion` (or 404s for a missing version, exercising the
 *  graceful-probe guard). The version-probe fetches are recorded for assertions. */
function apiWith(opts: { list: WorkflowConfig[]; byVersion?: Record<string, WorkflowConfig> }): { api: ApiClient; getCalls: string[] } {
  const getCalls: string[] = []
  const byVersion = opts.byVersion ?? {}
  const fetchFn = vi.fn(async (path: string) => {
    if (path.endsWith('/api/workflows')) {
      return { ok: true, status: 200, json: async () => opts.list, text: async () => '' } as unknown as Response
    }
    const m = path.match(/\/api\/workflows\/([^?]+)\?version=(\d+)/)
    if (m) {
      const key = `${decodeURIComponent(m[1]!)}@${m[2]}`
      getCalls.push(key)
      const found = byVersion[key]
      if (!found) return { ok: false, status: 404, json: async () => ({ error: 'workflow not found', code: 'NotFound' }), text: async () => '' } as unknown as Response
      return { ok: true, status: 200, json: async () => found, text: async () => '' } as unknown as Response
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response
  })
  return { api: new ApiClient('', fetchFn), getCalls }
}

describe('WorkflowList', () => {
  it('renders each workflow name with its current version', async () => {
    const { api } = apiWith({ list: [wf('a', 2, 'Alpha'), wf('b', 1, 'Beta')] })
    render(wrap(<WorkflowList api={api} onEdit={vi.fn()} onNew={vi.fn()} />))
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument())
    expect(screen.getByText('Beta')).toBeInTheDocument()
    const alpha = screen.getByTestId('workflow-a')
    expect(within(alpha).getByText(/Version 2/)).toBeInTheDocument()
    const beta = screen.getByTestId('workflow-b')
    expect(within(beta).getByText(/Version 1/)).toBeInTheDocument()
  })

  it('expanding a workflow at version 3 probes versions 2 & 1 via getWorkflow(id,n) and lists all three', async () => {
    const { api, getCalls } = apiWith({
      list: [wf('a', 3, 'Alpha')],
      byVersion: { 'a@2': wf('a', 2, 'Alpha'), 'a@1': wf('a', 1, 'Alpha') },
    })
    render(wrap(<WorkflowList api={api} onEdit={vi.fn()} onNew={vi.fn()} />))
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: 'Version history' }))

    // It probes the two prior versions (current version 3 is already known from the list).
    await waitFor(() => expect(getCalls).toEqual(expect.arrayContaining(['a@2', 'a@1'])))
    const history = screen.getByTestId('history-a')
    expect(within(history).getByText('v3')).toBeInTheDocument()
    expect(within(history).getByText('v2')).toBeInTheDocument()
    expect(within(history).getByText('v1')).toBeInTheDocument()
  })

  it('gracefully skips a missing prior version (404) without an unhandled rejection', async () => {
    // Only v2 exists; v1 404s — the list should still render v3 and v2 and not crash.
    const { api } = apiWith({ list: [wf('a', 3, 'Alpha')], byVersion: { 'a@2': wf('a', 2, 'Alpha') } })
    render(wrap(<WorkflowList api={api} onEdit={vi.fn()} onNew={vi.fn()} />))
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: 'Version history' }))
    const history = await screen.findByTestId('history-a')
    expect(within(history).getByText('v3')).toBeInTheDocument()
    expect(within(history).getByText('v2')).toBeInTheDocument()
    expect(within(history).queryByText('v1')).not.toBeInTheDocument()
  })

  it('shows the empty state when /api/workflows returns []', async () => {
    const { api } = apiWith({ list: [] })
    render(wrap(<WorkflowList api={api} onEdit={vi.fn()} onNew={vi.fn()} />))
    await waitFor(() => expect(screen.getByText('No workflows yet. Create your first preset.')).toBeInTheDocument())
  })

  it('Edit invokes onEdit(workflow) and New invokes onNew', async () => {
    const onEdit = vi.fn()
    const onNew = vi.fn()
    const alpha = wf('a', 2, 'Alpha')
    const { api } = apiWith({ list: [alpha] })
    render(wrap(<WorkflowList api={api} onEdit={onEdit} onNew={onNew} />))
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument())

    await userEvent.click(within(screen.getByTestId('workflow-a')).getByRole('button', { name: 'Edit' }))
    expect(onEdit).toHaveBeenCalledWith(alpha)

    await userEvent.click(screen.getByRole('button', { name: 'New workflow' }))
    expect(onNew).toHaveBeenCalledTimes(1)
  })
})
