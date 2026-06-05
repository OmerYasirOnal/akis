import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import type { TestEvidence } from '@akis/shared'
import { TrustReport } from './TrustReport.js'
import { I18nProvider } from '../i18n/I18nContext.js'
import { STRINGS } from '../i18n/catalog.js'
import type { CodeReviewState } from '../live/types.js'

/** TrustReport reads i18n strings, so render it inside the provider (default: EN). */
const renderI18n = (ui: ReactElement) => render(<I18nProvider>{ui}</I18nProvider>)

const passingEvidence: TestEvidence = {
  testsRun: 3,
  passed: true,
  durationMs: 1234,
  bdd: { built: 2, run: 2, passed: 2, failed: 0, skipped: 0, durationMs: 800 },
  e2e: { testsRun: 1, passed: true, expected: 1, unexpected: 0, flaky: 0, skipped: 0, durationMs: 434 },
  scenarios: [
    { name: 'User can sign up', suite: 'bdd', passed: true },
    { name: 'User can log in', suite: 'bdd', passed: true },
    { name: 'Homepage renders', suite: 'e2e', passed: true },
  ],
}

const failingEvidence: TestEvidence = {
  testsRun: 2,
  passed: false,
  durationMs: 900,
  bdd: { built: 2, run: 2, passed: 1, failed: 1, skipped: 0, durationMs: 600 },
  e2e: { testsRun: 0, passed: false, expected: 0, unexpected: 0, flaky: 0, skipped: 0, durationMs: 300 },
  scenarios: [
    { name: 'Checkout succeeds', suite: 'bdd', passed: true },
    { name: 'Refund is issued', suite: 'bdd', passed: false, reason: 'Then the balance is refunded', step: 'Then the balance is refunded' },
  ],
  failure: {
    failedCount: 1,
    scenarios: [
      { name: 'Refund is issued', suite: 'bdd', passed: false, reason: 'Then the balance is refunded', step: 'Then the balance is refunded' },
    ],
  },
}

describe('TrustReport', () => {
  it('renders a graceful empty state when there is no evidence', () => {
    renderI18n(<TrustReport />)
    expect(screen.getByText(STRINGS.en['trust.empty'])).toBeInTheDocument()
  })

  it('shows counts and duration (total tests, passed/failed, run time)', () => {
    renderI18n(<TrustReport evidence={passingEvidence} />)
    // The count labels surface…
    expect(screen.getByText(STRINGS.en['trust.tests'])).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['trust.passed'])).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['trust.failed'])).toBeInTheDocument()
    expect(screen.getByText(STRINGS.en['trust.duration'])).toBeInTheDocument()
    // …with the right values (testsRun=3 and passedCount=3 both render "3").
    expect(screen.getAllByText('3').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('0')).toBeInTheDocument() // failed count
    // Duration rendered (raw ms).
    expect(screen.getByText('1234ms')).toBeInTheDocument()
  })

  it('renders each named scenario with its suite and a pass marker', () => {
    renderI18n(<TrustReport evidence={passingEvidence} />)
    expect(screen.getByText('User can sign up')).toBeInTheDocument()
    expect(screen.getByText('User can log in')).toBeInTheDocument()
    expect(screen.getByText('Homepage renders')).toBeInTheDocument()
  })

  it('shows a failing scenario with its structured reason/step', () => {
    renderI18n(<TrustReport evidence={failingEvidence} />)
    expect(screen.getByText('Refund is issued')).toBeInTheDocument()
    // The structured reason / step text surfaces (it appears in scenario + failure list)
    expect(screen.getAllByText('Then the balance is refunded').length).toBeGreaterThan(0)
  })

  it('surfaces the top-level failure.reason when present (timeout / all-skipped / zero-tests)', () => {
    const zeroTests: TestEvidence = {
      testsRun: 0,
      passed: false,
      durationMs: 0,
      bdd: { built: 0, run: 0, passed: 0, failed: 0, skipped: 0, durationMs: 0 },
      e2e: { testsRun: 0, passed: false, expected: 0, unexpected: 0, flaky: 0, skipped: 0, durationMs: 0 },
      scenarios: [],
      failure: { failedCount: 0, scenarios: [], reason: 'no tests were run' },
    }
    renderI18n(<TrustReport evidence={zeroTests} />)
    expect(screen.getByText('no tests were run')).toBeInTheDocument()
  })

  it('shows the critic verdict (approved / findings / critical / iteration)', () => {
    const review: CodeReviewState = { approved: true, findings: 0, critical: false, iteration: 1 }
    renderI18n(<TrustReport evidence={passingEvidence} codeReview={review} />)
    expect(screen.getByText(STRINGS.en['trust.critic.approved'])).toBeInTheDocument()
  })

  it('shows a NOT-approved critic verdict with finding count and critical flag', () => {
    const review: CodeReviewState = { approved: false, findings: 4, critical: true, iteration: 2 }
    renderI18n(<TrustReport evidence={failingEvidence} codeReview={review} />)
    expect(screen.getByText(STRINGS.en['trust.critic.rejected'])).toBeInTheDocument()
    // finding count surfaces
    expect(screen.getByText(/4/)).toBeInTheDocument()
    // critical flag surfaces
    expect(screen.getByText(STRINGS.en['trust.critic.critical'])).toBeInTheDocument()
  })

  it('prominently flags a DEMO (simulated) verification', () => {
    renderI18n(<TrustReport evidence={passingEvidence} demo />)
    const badge = screen.getByRole('status')
    expect(badge).toHaveTextContent(STRINGS.en['result.demo.badge'])
    expect(badge).toHaveAttribute('title', STRINGS.en['result.demo.title'])
  })

  it('shows NO demo badge on a live run', () => {
    renderI18n(<TrustReport evidence={passingEvidence} />)
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByText(STRINGS.en['result.demo.badge'], { exact: false })).toBeNull()
  })

  describe('Copy evidence (plain-text digest)', () => {
    it('copies a digest containing the counts and each scenario name', async () => {
      const writeText = vi.fn((_text: string) => Promise.resolve())
      Object.assign(navigator, { clipboard: { writeText } })
      const review: CodeReviewState = { approved: true, findings: 0, critical: false, iteration: 1 }
      renderI18n(<TrustReport evidence={passingEvidence} codeReview={review} />)
      fireEvent.click(screen.getByRole('button', { name: STRINGS.en['copy.evidence'] }))
      await waitFor(() => expect(writeText).toHaveBeenCalled())
      const digest = writeText.mock.calls[0]![0] as string
      expect(digest).toContain('Tests: 3')
      expect(digest).toContain('Passed: 3')
      expect(digest).toContain('User can sign up')
      expect(digest).toContain('User can log in')
      expect(digest).toContain('Homepage renders')
      // Critic verdict line present.
      expect(digest).toContain(STRINGS.en['trust.critic.approved'])
    })

    it('DEMO line keys off the demo PROP, not evidence.demo (true → present)', async () => {
      const writeText = vi.fn((_text: string) => Promise.resolve())
      Object.assign(navigator, { clipboard: { writeText } })
      // passingEvidence has NO evidence.demo field — the DEMO line must come from the prop alone.
      renderI18n(<TrustReport evidence={passingEvidence} demo />)
      fireEvent.click(screen.getByRole('button', { name: STRINGS.en['copy.evidence'] }))
      await waitFor(() => expect(writeText).toHaveBeenCalled())
      expect(writeText.mock.calls[0]![0] as string).toContain('DEMO')
    })

    it('DEMO line absent when demo={false} (tracks the prop, not evidence.demo)', async () => {
      const writeText = vi.fn((_text: string) => Promise.resolve())
      Object.assign(navigator, { clipboard: { writeText } })
      renderI18n(<TrustReport evidence={passingEvidence} demo={false} />)
      fireEvent.click(screen.getByRole('button', { name: STRINGS.en['copy.evidence'] }))
      await waitFor(() => expect(writeText).toHaveBeenCalled())
      expect(writeText.mock.calls[0]![0] as string).not.toContain('DEMO')
    })

    it('shows no copy button when there is no evidence', () => {
      renderI18n(<TrustReport />)
      expect(screen.queryByRole('button', { name: STRINGS.en['copy.evidence'] })).toBeNull()
    })
  })

  it('renders a <script>-in-a-reason as TEXT, never an executed node (XSS guard)', () => {
    const xss: TestEvidence = {
      testsRun: 1,
      passed: false,
      durationMs: 10,
      bdd: { built: 1, run: 1, passed: 0, failed: 1, skipped: 0, durationMs: 10 },
      e2e: { testsRun: 0, passed: false, expected: 0, unexpected: 0, flaky: 0, skipped: 0, durationMs: 0 },
      scenarios: [
        { name: '<img src=x onerror=alert(1)>', suite: 'bdd', passed: false, reason: '<script>alert(1)</script>', step: '<script>alert(1)</script>' },
      ],
      failure: {
        failedCount: 1,
        scenarios: [
          { name: '<img src=x onerror=alert(1)>', suite: 'bdd', passed: false, reason: '<script>alert(1)</script>' },
        ],
        reason: '<script>document.cookie</script>',
      },
    }
    const { container } = renderI18n(<TrustReport evidence={xss} />)
    // The malicious strings render as literal text…
    expect(screen.getAllByText('<script>alert(1)</script>').length).toBeGreaterThan(0)
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument()
    expect(screen.getByText('<script>document.cookie</script>')).toBeInTheDocument()
    // …and NO script/img node was actually injected into the DOM.
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
  })
})
