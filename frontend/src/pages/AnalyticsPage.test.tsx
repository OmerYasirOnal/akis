import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { AnalyticsPage } from './AnalyticsPage.js'
import { I18nProvider } from '../i18n/I18nContext.js'
import { ApiClient, type Analytics } from '../api/client.js'

const ANALYTICS: Analytics = {
  sessions: 3, done: 2, failed: 0, running: 1,
  verifiedRuns: 2, testsRun: 12, passRate: 0.5,
  agents: [{ agent: 'trace', runs: 4, ok: 3 }],
}

function apiWith(data: Analytics): ApiClient {
  const fetchFn = vi.fn(async (path: string) =>
    path.endsWith('/api/analytics')
      ? ({ ok: true, status: 200, json: async () => data, text: async () => '' } as unknown as Response)
      : ({ ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response),
  )
  return new ApiClient('', fetchFn)
}

/** Minimal render guard: the dashboard mounts without throwing (so a missing i18n key would
 *  surface), maps the agent activity row to its shared proper noun, and uses the localized
 *  "ok" suffix rather than a hardcoded literal. */
describe('AnalyticsPage', () => {
  it('renders per-agent activity with the shared name and the localized ok suffix', async () => {
    render(<I18nProvider><AnalyticsPage api={apiWith(ANALYTICS)} /></I18nProvider>)
    expect(await screen.findByText('Trace')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('3/4 ok')).toBeInTheDocument())
  })
})
