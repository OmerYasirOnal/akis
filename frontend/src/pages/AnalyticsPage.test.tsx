import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { AnalyticsPage } from './AnalyticsPage.js'
import { I18nProvider } from '../i18n/I18nContext.js'
import { ApiClient, type Analytics, type SessionSummary } from '../api/client.js'
import type { AkisEvent } from '@akis/shared'
import type { SeqEvent } from '../live/types.js'

const ANALYTICS: Analytics = {
  sessions: 3, done: 2, failed: 0, running: 1,
  verifiedRuns: 2, testsRun: 12, passRate: 0.5,
  agents: [{ agent: 'trace', runs: 4, ok: 3 }],
}

const ev = (e: Partial<AkisEvent> & { kind: AkisEvent['kind'] }, sessionId: string): AkisEvent =>
  ({ agent: 'orchestrator', laneId: 'main', sessionId, ts: 0, ...(e as object) }) as AkisEvent
const seq = (events: AkisEvent[]): SeqEvent[] => events.map((event, i) => ({ seq: i, event }))

// Two history rows: one with present-usage agent_end metrics, one with usage-absent (Trace-only).
const SESSIONS: SessionSummary[] = [
  { id: 'with-tokens', idea: 'Voting app', status: 'done', verified: true },
  { id: 'no-tokens', idea: 'Static page', status: 'done', verified: false },
]
const LOGS: Record<string, AkisEvent[]> = {
  'with-tokens': [
    ev({ kind: 'agent_start', role: 'proto', agent: 'proto', laneId: 'main' }, 'with-tokens'),
    ev({ kind: 'agent_end', role: 'proto', ok: true, agent: 'proto', laneId: 'main', metrics: { usage: { inTokens: 8000, outTokens: 4345 }, durationMs: 42_000, toolCalls: 1 } }, 'with-tokens'),
  ],
  'no-tokens': [
    ev({ kind: 'agent_start', role: 'trace', agent: 'trace', laneId: 'verify' }, 'no-tokens'),
    ev({ kind: 'agent_end', role: 'trace', ok: true, agent: 'trace', laneId: 'verify', metrics: { durationMs: 1_000, toolCalls: 1 } }, 'no-tokens'),
  ],
}

/** A fake fetch that answers /api/analytics, /sessions/mine, and /sessions/:id/log. The log
 *  MUST come back as {events,head} (getSessionLog destructures {events}), not a bare array. */
function apiWith(data: Analytics): ApiClient {
  const fetchFn = vi.fn(async (path: string) => {
    if (path.endsWith('/api/analytics')) return resp(data)
    if (path.endsWith('/sessions/mine')) return resp(SESSIONS)
    const log = path.match(/\/sessions\/([^/]+)\/log$/)
    if (log) return resp({ events: seq(LOGS[log[1]!] ?? []), head: 0 })
    return resp({})
  })
  return new ApiClient('', fetchFn)
}
const resp = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body, text: async () => '' } as unknown as Response)

describe('AnalyticsPage', () => {
  it('renders per-agent activity with the shared name and the localized ok suffix', async () => {
    render(<I18nProvider><AnalyticsPage api={apiWith(ANALYTICS)} /></I18nProvider>)
    // 'Trace' appears both in the activity row and the per-run breakdown — assert on the
    // activity stat, which is unique.
    await waitFor(() => expect(screen.getByText('3/4 ok')).toBeInTheDocument())
    expect((await screen.findAllByText('Trace')).length).toBeGreaterThanOrEqual(1)
  })

  it('renders the per-run cost section: a real token total for a metric-bearing run, "—" for an absent-usage run', async () => {
    render(<I18nProvider><AnalyticsPage api={apiWith(ANALYTICS)} /></I18nProvider>)
    // The section title + both run ideas appear.
    expect(await screen.findByText('Per-run cost')).toBeInTheDocument()
    expect(await screen.findByText('Voting app')).toBeInTheDocument()
    expect(screen.getByText('Static page')).toBeInTheDocument()
    // The token-bearing run shows a real total (8000+4345 = 12345 → "12.3k"); the absent-usage
    // run shows the honest dash (appears for both the total and the per-agent cell), never a 0.
    await waitFor(() => expect(screen.getByText('12.3k')).toBeInTheDocument())
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1)
    // No fabricated "0 tok" anywhere on the page for the absent-usage run.
    expect(screen.queryByText(/0 tok/)).toBeNull()
  })
})
