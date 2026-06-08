/**
 * PreviewPanel header actions — open-in-new-tab + copy-URL.
 * WHY: these are FRONTEND, view-state-only affordances. Pin (1) they render ONLY when the live
 * URL is embeddable (`/preview/`), never for a missing/non-/preview/ URL (honesty — no dead
 * buttons); (2) open-in-tab calls window.open with the (relative) preview URL; (3) copy lifts the
 * ABSOLUTE URL (resolved against the studio origin) so it's shareable outside the studio.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import type { ReactElement } from 'react'
import { I18nProvider } from '../i18n/I18nContext.js'
import { PreviewPanel } from './PreviewPanel.js'
import type { SessionView } from '../live/types.js'

const renderI18n = (ui: ReactElement) => render(<I18nProvider>{ui}</I18nProvider>)

/** Minimal SessionView with a preview URL knob — everything else is an inert default. */
const viewWith = (url: string | undefined): SessionView => ({
  sessionId: 's1',
  status: 'done',
  lanes: [],
  gates: {},
  tests: { testsRun: 0, passed: false, ran: false },
  preview: { ready: !!url, ...(url !== undefined ? { url } : {}) },
  errors: [],
})

const renderPanel = (url: string | undefined) =>
  renderI18n(
    <PreviewPanel
      view={viewWith(url)}
      device="responsive"
      onDevice={() => {}}
    />,
  )

test('open-in-tab + copy actions appear when the URL is embeddable (/preview/)', () => {
  renderPanel('/preview/abc/')
  expect(screen.getByRole('button', { name: /open in new tab|yeni sekmede aç/i })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /copy url|url'yi kopyala/i })).toBeInTheDocument()
})

test('actions are HIDDEN when there is no preview URL (no dead buttons)', () => {
  renderPanel(undefined)
  expect(screen.queryByRole('button', { name: /open in new tab|yeni sekmede aç/i })).toBeNull()
  expect(screen.queryByRole('button', { name: /copy url|url'yi kopyala/i })).toBeNull()
})

test('actions are HIDDEN for a non-/preview/ URL (e.g. an external artifact)', () => {
  renderPanel('https://example.com/app')
  expect(screen.queryByRole('button', { name: /open in new tab|yeni sekmede aç/i })).toBeNull()
  expect(screen.queryByRole('button', { name: /copy url|url'yi kopyala/i })).toBeNull()
})

test('open-in-tab calls window.open with the preview URL (noopener,noreferrer)', () => {
  const open = vi.spyOn(window, 'open').mockReturnValue(null)
  try {
    renderPanel('/preview/abc/')
    fireEvent.click(screen.getByRole('button', { name: /open in new tab|yeni sekmede aç/i }))
    expect(open).toHaveBeenCalledWith('/preview/abc/', '_blank', 'noopener,noreferrer')
  } finally {
    open.mockRestore()
  }
})

test('copy lifts the ABSOLUTE preview URL (resolved against the studio origin)', async () => {
  const writeText = vi.fn<(t: string) => Promise<void>>().mockResolvedValue(undefined)
  // jsdom has no clipboard by default — install a minimal fake.
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  try {
    renderPanel('/preview/abc/')
    fireEvent.click(screen.getByRole('button', { name: /copy url|url'yi kopyala/i }))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    expect(writeText).toHaveBeenCalledWith(new URL('/preview/abc/', location.origin).href)
  } finally {
    // @ts-expect-error — remove the fake so other suites see the original (absent) clipboard.
    delete navigator.clipboard
  }
})
