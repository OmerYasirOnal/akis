import { describe, it, expect, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PreviewPanel } from './PreviewPanel.js'
import { emptyView } from '../live/viewModel.js'
import type { SessionView } from '../live/types.js'
import type { TestEvidence } from '@akis/shared'
import { I18nProvider } from '../i18n/I18nContext.js'
import { STRINGS } from '../i18n/catalog.js'
import type { ReactElement } from 'react'

const evidence: TestEvidence = {
  testsRun: 2, passed: true, durationMs: 500,
  bdd: { built: 1, run: 1, passed: 1, failed: 0, skipped: 0, durationMs: 300 },
  e2e: { testsRun: 1, passed: true, expected: 1, unexpected: 0, flaky: 0, skipped: 0, durationMs: 200 },
  scenarios: [
    { name: 'User can sign up', suite: 'bdd', passed: true },
    { name: 'Homepage renders', suite: 'e2e', passed: true },
  ],
}

/** PreviewPanel reads i18n strings, so render it inside the provider (default: EN). */
const renderI18n = (ui: ReactElement) => render(<I18nProvider>{ui}</I18nProvider>)

describe('PreviewPanel', () => {
  it('shows the shipped artifact url and pass/fail stats', () => {
    const view: SessionView = { ...emptyView('s1'), preview: { artifactUrl: 'https://github.com/mock/s1', ready: true }, tests: { testsRun: 2, passed: true, ran: true }, verified: true }
    renderI18n(<PreviewPanel device="responsive" onDevice={() => {}} view={view} />)
    expect(screen.getByText('https://github.com/mock/s1')).toBeInTheDocument()
    expect(screen.getByText('PASS')).toBeInTheDocument()
    expect(screen.getByText('verified')).toBeInTheDocument()
  })
  it('embeds the running app in an iframe when the url is a /preview/ path', () => {
    const view: SessionView = { ...emptyView('s1'), preview: { url: '/preview/s1/', ready: true } }
    const { container } = renderI18n(<PreviewPanel device="responsive" onDevice={() => {}} view={view} />)
    const iframe = container.querySelector('iframe')
    expect(iframe).not.toBeNull()
    expect(iframe?.getAttribute('src')).toBe('/preview/s1/')
  })
  it('never embeds a non-/preview/ url (and the iframe has no allow-same-origin)', () => {
    const view: SessionView = { ...emptyView('s1'), preview: { url: '/preview/s1/', ready: true } }
    const { container } = renderI18n(<PreviewPanel device="responsive" onDevice={() => {}} view={view} />)
    expect(container.querySelector('iframe')?.getAttribute('sandbox')).not.toContain('allow-same-origin')
  })
  it('shows a placeholder before any run', () => {
    renderI18n(<PreviewPanel device="responsive" onDevice={() => {}} view={emptyView('s1')} />)
    expect(screen.getByText(/Run the app to see it live/)).toBeInTheDocument()
  })
  it('renders a non-http(s) (javascript:) artifact url as plain text, never a clickable href (XSS guard)', () => {
    const view: SessionView = { ...emptyView('s1'), preview: { artifactUrl: 'javascript:alert(1)', ready: true } }
    const { container } = renderI18n(<PreviewPanel device="responsive" onDevice={() => {}} view={view} />)
    expect(screen.getByText('javascript:alert(1)')).toBeInTheDocument()
    expect(container.querySelector('a')).toBeNull() // no anchor → no js: sink
  })
  it('never embeds a non-/preview/ url in the iframe (no agent-url sink)', () => {
    const view: SessionView = { ...emptyView('s1'), preview: { url: 'https://evil.example', ready: true } }
    const { container } = renderI18n(<PreviewPanel device="responsive" onDevice={() => {}} view={view} />)
    expect(container.querySelector('iframe')).toBeNull()
  })
  it('shows the mock-provider demo note only for the mock provider', () => {
    const mock: SessionView = { ...emptyView('s1'), provider: 'mock' }
    const { rerender } = renderI18n(<PreviewPanel device="responsive" onDevice={() => {}} view={mock} />)
    expect(screen.getByText(/Demo preview \(mock provider\)/)).toBeInTheDocument()
    // a real provider must NOT show the note
    rerender(<I18nProvider><PreviewPanel device="responsive" onDevice={() => {}} view={{ ...emptyView('s1'), provider: 'anthropic' }} /></I18nProvider>)
    expect(screen.queryByText(/Demo preview \(mock provider\)/)).toBeNull()
  })
  it('keeps the iframe sandbox isolated while allowing clipboard writes', () => {
    const view: SessionView = { ...emptyView('s1'), preview: { url: '/preview/s1/', ready: true } }
    const { container } = renderI18n(<PreviewPanel device="responsive" onDevice={() => {}} view={view} />)
    expect(container.querySelector('iframe')?.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-popups')
    expect(container.querySelector('iframe')?.getAttribute('allow')).toBe('clipboard-write')
  })
  // Task 4 (gate-safe): the iframe is now WRAPPED in DeviceFrame, but its sandbox/allow must stay
  // byte-for-byte — DeviceFrame only sets WIDTH, never src/sandbox/allow. Guards the L5 invariant.
  it('preview iframe keeps its sandbox and clipboard-write allow when wrapped in DeviceFrame (gate-safe)', () => {
    const view: SessionView = { ...emptyView('s1'), preview: { url: '/preview/abc/', ready: true } }
    const { container } = renderI18n(<PreviewPanel view={view} device="responsive" onDevice={() => {}} canRun onRun={() => {}} />)
    const f = container.querySelector('iframe')
    expect(f).not.toBeNull()
    expect(f?.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-popups')
    expect(f?.getAttribute('allow')).toBe('clipboard-write')
    expect(f?.getAttribute('sandbox')).not.toContain('allow-same-origin')
    // DeviceFrame wraps it: the device-frame width host is an ancestor of the iframe.
    const frame = screen.getByTestId('device-frame')
    expect(frame.contains(f)).toBe(true)
  })

  // P1-CORE-1: a simulated (mock-runner / demo-boot) result must be flagged AT THE RESULT —
  // on the verify card (TestStats) and the preview — so it can't be mistaken for a real pass.
  it('flags a SIMULATED verification on the verify card when tests.demo', () => {
    const view: SessionView = { ...emptyView('s1'), tests: { testsRun: 2, passed: true, ran: true, demo: true } }
    renderI18n(<PreviewPanel device="responsive" onDevice={() => {}} view={view} />)
    const badge = screen.getByRole('status')
    expect(badge).toHaveTextContent(STRINGS.en['result.demo.badge'])
    expect(badge).toHaveAttribute('title', STRINGS.en['result.demo.title'])
  })
  it('flags a DEMO boot on the preview header when preview.demo', () => {
    const view: SessionView = { ...emptyView('s1'), preview: { url: '/preview/s1/', ready: true, demo: true } }
    renderI18n(<PreviewPanel device="responsive" onDevice={() => {}} view={view} />)
    expect(screen.getByRole('status')).toHaveTextContent(STRINGS.en['result.demo.badge'])
  })
  it('shows NO demo badge on a live run (no demo flags)', () => {
    const view: SessionView = { ...emptyView('s1'), tests: { testsRun: 5, passed: true, ran: true }, preview: { url: '/preview/s1/', ready: true }, verified: true }
    renderI18n(<PreviewPanel device="responsive" onDevice={() => {}} view={view} />)
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByText(STRINGS.en['result.demo.badge'], { exact: false })).toBeNull()
  })

  // ── Code tab: the read-only browser of the agent-written files (SessionState.code.files) ──
  it('shows NO Preview⇄Code toggle when there are no generated files', () => {
    renderI18n(<PreviewPanel device="responsive" onDevice={() => {}} view={emptyView('s1')} />)
    expect(screen.queryByRole('tab', { name: STRINGS.en['preview.tab.code'] })).toBeNull()
  })
  it('shows the Preview⇄Code toggle (with file count) once files exist, defaulting to Preview', () => {
    const files = [{ filePath: 'app.ts', content: 'a' }, { filePath: 'README.md', content: 'b' }]
    const view: SessionView = { ...emptyView('s1'), preview: { url: '/preview/s1/', ready: true } }
    const { container } = renderI18n(<PreviewPanel device="responsive" onDevice={() => {}} view={view} files={files} />)
    expect(screen.getByRole('tab', { name: /Code/ })).toBeInTheDocument()
    // default tab is Preview → iframe still shown, no code list yet
    expect(container.querySelector('iframe')).not.toBeNull()
  })
  it('switches to the Code view, showing the file list + selected content (iframe gone)', async () => {
    const user = userEvent.setup()
    const files = [{ filePath: 'app.ts', content: 'export const hello = 1' }]
    const view: SessionView = { ...emptyView('s1'), preview: { url: '/preview/s1/', ready: true } }
    const { container } = renderI18n(<PreviewPanel device="responsive" onDevice={() => {}} view={view} files={files} />)
    await user.click(screen.getByRole('tab', { name: /Code/ }))
    expect(screen.getByText('export const hello = 1')).toBeInTheDocument()
    // 'app.ts' shows in the file list (and the viewer header) — assert it's in the list
    expect(screen.getByRole('list', { name: /Generated code/i })).toHaveTextContent('app.ts')
    // the preview iframe is not mounted on the Code tab
    expect(container.querySelector('iframe')).toBeNull()
  })
  it('renders code content as TEXT on the Code tab — never an executed <script> (XSS guard)', async () => {
    const user = userEvent.setup()
    const files = [{ filePath: 'evil.html', content: '<script>alert(1)</script>' }]
    const { container } = renderI18n(<PreviewPanel device="responsive" onDevice={() => {}} view={emptyView('s1')} files={files} />)
    await user.click(screen.getByRole('tab', { name: /Code/ }))
    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument()
    expect(container.querySelector('script')).toBeNull()
  })
  it('recovers to Preview when files vanish while on the Code tab (no dead-end trap)', async () => {
    const user = userEvent.setup()
    const files = [{ filePath: 'app.ts', content: 'export const x = 1' }]
    const view: SessionView = { ...emptyView('s1'), preview: { url: '/preview/s1/', ready: true } }
    const { container, rerender } = renderI18n(<PreviewPanel device="responsive" onDevice={() => {}} view={view} files={files} />)
    await user.click(screen.getByRole('tab', { name: /Code/ }))
    expect(container.querySelector('iframe')).toBeNull() // now on the Code tab
    // Files vanish (e.g. New chat, or switching to a session with no code yet) → the tablist hides.
    rerender(<I18nProvider><PreviewPanel device="responsive" onDevice={() => {}} view={view} files={undefined} /></I18nProvider>)
    // Must NOT be stranded on an empty Code view: the Code tab is gone AND the live preview is back.
    expect(screen.queryByRole('tab', { name: STRINGS.en['preview.tab.code'] })).toBeNull()
    expect(container.querySelector('iframe')).not.toBeNull()
  })

  // ── Trust tab: the auditable structured evidence behind the verified result ──
  it('shows NO Trust tab when there is no test evidence', () => {
    renderI18n(<PreviewPanel device="responsive" onDevice={() => {}} view={emptyView('s1')} />)
    expect(screen.queryByRole('tab', { name: STRINGS.en['trust.tab'] })).toBeNull()
  })
  it('shows the Trust tab once test evidence exists, and switches to the report', async () => {
    const user = userEvent.setup()
    const view: SessionView = {
      ...emptyView('s1'),
      preview: { url: '/preview/s1/', ready: true },
      codeReview: { approved: true, findings: 0, critical: false, iteration: 1 },
    }
    const { container } = renderI18n(<PreviewPanel device="responsive" onDevice={() => {}} view={view} testEvidence={evidence} />)
    await user.click(screen.getByRole('tab', { name: STRINGS.en['trust.tab'] }))
    // The named scenarios + critic verdict surface; the live iframe is gone on the Trust tab.
    expect(screen.getByText('User can sign up')).toBeInTheDocument()
    expect(screen.getByText('Homepage renders')).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['trust.critic.approved'])).toBeInTheDocument()
    expect(container.querySelector('iframe')).toBeNull()
  })
  it('flags a DEMO verification on the Trust report when tests.demo', async () => {
    const user = userEvent.setup()
    const view: SessionView = { ...emptyView('s1'), tests: { testsRun: 2, passed: true, ran: true, demo: true } }
    renderI18n(<PreviewPanel device="responsive" onDevice={() => {}} view={view} testEvidence={evidence} />)
    await user.click(screen.getByRole('tab', { name: STRINGS.en['trust.tab'] }))
    expect(screen.getByRole('status')).toHaveTextContent(STRINGS.en['result.demo.badge'])
  })
  it('recovers to Preview when evidence vanishes while on the Trust tab (no dead-end trap)', async () => {
    const user = userEvent.setup()
    const view: SessionView = { ...emptyView('s1'), preview: { url: '/preview/s1/', ready: true } }
    const { container, rerender } = renderI18n(<PreviewPanel device="responsive" onDevice={() => {}} view={view} testEvidence={evidence} />)
    await user.click(screen.getByRole('tab', { name: STRINGS.en['trust.tab'] }))
    expect(container.querySelector('iframe')).toBeNull() // now on the Trust tab
    rerender(<I18nProvider><PreviewPanel device="responsive" onDevice={() => {}} view={view} testEvidence={undefined} /></I18nProvider>)
    expect(screen.queryByRole('tab', { name: STRINGS.en['trust.tab'] })).toBeNull()
    expect(container.querySelector('iframe')).not.toBeNull()
  })

  // ── Lane A: a preview-boot FAILURE is visible + recoverable, never a silent collapse to empty ──
  it('shows a rose error card with the reason on a failed preview boot (XSS-safe text)', () => {
    const view: SessionView = { ...emptyView('s1'), preview: { ready: false, error: { status: 'failed', reason: 'install failed: npm ci exited 1' } } }
    const { container } = renderI18n(<PreviewPanel device="responsive" onDevice={() => {}} view={view} onRun={() => {}} canRun={false} />)
    expect(screen.getByText(STRINGS.en['preview.failed'])).toBeInTheDocument()
    expect(screen.getByText('install failed: npm ci exited 1')).toBeInTheDocument()
    // It must NOT collapse to the empty "Run the app…" placeholder.
    expect(screen.queryByText(STRINGS.en['preview.empty'])).toBeNull()
    // Reason is rendered as text — no script sink.
    expect(container.querySelector('script')).toBeNull()
  })
  it('uses the unsupported copy when the failure status is unsupported', () => {
    const view: SessionView = { ...emptyView('s1'), preview: { ready: false, error: { status: 'unsupported' } } }
    renderI18n(<PreviewPanel device="responsive" onDevice={() => {}} view={view} onRun={() => {}} canRun={false} />)
    expect(screen.getByText(STRINGS.en['preview.unsupported'])).toBeInTheDocument()
    expect(screen.queryByText(STRINGS.en['preview.failed'])).toBeNull()
  })
  it('renders a working Retry that calls onRun, even when canRun is false', async () => {
    const user = userEvent.setup()
    const onRun = vi.fn()
    const view: SessionView = { ...emptyView('s1'), preview: { ready: false, error: { status: 'failed', reason: 'boom' } } }
    renderI18n(<PreviewPanel device="responsive" onDevice={() => {}} view={view} onRun={onRun} canRun={false} />)
    const retry = screen.getByRole('button', { name: new RegExp(STRINGS.en['preview.retry']) })
    expect(retry).toBeInTheDocument()
    await user.click(retry)
    expect(onRun).toHaveBeenCalledTimes(1)
  })
  it('renders the actionError note near the Run control', () => {
    const view: SessionView = { ...emptyView('s1'), provider: 'anthropic' }
    renderI18n(<PreviewPanel device="responsive" onDevice={() => {}} view={view} onRun={() => {}} canRun actionError="preview failed: boom" />)
    expect(screen.getByText('preview failed: boom')).toBeInTheDocument()
  })
  // Regression (PR #82 review): a re-run that fails can leave a STALE /preview/ url in the view
  // (ready→stopped→starting→failed). The iframe is gated on `!previewError`, so a present failure
  // must win — the dead frame can never shadow the error card + Retry.
  it('shows the error card (not a stale iframe) when a failed preview still carries a url', () => {
    const view: SessionView = { ...emptyView('s1'), preview: { ready: false, url: '/preview/s1/', error: { status: 'failed', reason: 'readiness probe timed out' } } }
    const { container } = renderI18n(<PreviewPanel device="responsive" onDevice={() => {}} view={view} onRun={() => {}} canRun={false} />)
    expect(container.querySelector('iframe')).toBeNull() // the dead frame is NOT mounted
    expect(screen.getByText(STRINGS.en['preview.failed'])).toBeInTheDocument()
    expect(screen.getByText('readiness probe timed out')).toBeInTheDocument()
  })
  // The same failure must not be double-banner'd: when the rose error card is already shown, the
  // redundant actionError banner is suppressed (it stays as the fallback for a dropped SSE frame).
  it('suppresses the actionError banner when a preview_status failure card is shown', () => {
    const view: SessionView = { ...emptyView('s1'), preview: { ready: false, error: { status: 'failed', reason: 'probe timed out' } } }
    renderI18n(<PreviewPanel device="responsive" onDevice={() => {}} view={view} onRun={() => {}} canRun actionError="run failed: dup" />)
    expect(screen.getByText('probe timed out')).toBeInTheDocument() // the card reason
    expect(screen.queryByText('run failed: dup')).toBeNull() // the duplicate banner is gone
  })
  // Boot watchdog: a still-running boot past the threshold must surface a non-blocking note + Retry
  // so a LOST terminal frame can't strand the spinner forever.
  it('surfaces the boot-watchdog note after the threshold while still booting', () => {
    vi.useFakeTimers()
    try {
      const view: SessionView = { ...emptyView('s1'), preview: { ready: false, starting: true } }
      renderI18n(<PreviewPanel device="responsive" onDevice={() => {}} view={view} onRun={() => {}} canRun />)
      expect(screen.queryByText(STRINGS.en['preview.bootSlow'])).toBeNull() // not yet
      act(() => { vi.advanceTimersByTime(125_000) })
      expect(screen.getByText(STRINGS.en['preview.bootSlow'])).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})
