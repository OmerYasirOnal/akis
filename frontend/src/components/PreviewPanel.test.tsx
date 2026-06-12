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
import { foldSessionView } from '../live/viewModel.js'
import type { SessionView } from '../live/types.js'
import type { AkisEvent } from '@akis/shared'

const renderI18n = (ui: ReactElement) => render(<I18nProvider>{ui}</I18nProvider>)

/** Minimal SessionView with a preview URL knob — everything else is an inert default. The optional
 *  `verified` knob drives the honest verified/unverified chip (PREVIEW-UNGATED tests below). */
const viewWith = (url: string | undefined, verified?: boolean): SessionView => ({
  sessionId: 's1',
  status: 'done',
  lanes: [],
  gates: {},
  tests: { testsRun: 0, passed: false, ran: false },
  preview: { ready: !!url, ...(url !== undefined ? { url } : {}) },
  errors: [],
  ...(verified !== undefined ? { verified } : {}),
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

test('refresh button appears (embeddable) and is hidden for a non-/preview/ URL', () => {
  const { unmount } = renderPanel('/preview/abc/')
  expect(screen.getByRole('button', { name: /refresh preview|önizlemeyi yenile/i })).toBeInTheDocument()
  unmount()
  renderPanel('https://example.com/app')
  expect(screen.queryByRole('button', { name: /refresh preview|önizlemeyi yenile/i })).toBeNull()
})

test('refresh REMOUNTS the iframe (re-fetches the SAME src) and re-arms the loading skeleton', () => {
  const { container } = renderPanel('/preview/abc/')
  const iframe1 = container.querySelector('iframe')!
  // Paint the iframe (onLoad) so the skeleton fades out — then refresh must bring it back.
  fireEvent.load(iframe1)
  expect(iframe1.className).toMatch(/opacity-100/)
  expect(screen.queryByText(/rendering|çiziliyor/i)).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: /refresh preview|önizlemeyi yenile/i }))

  const iframe2 = container.querySelector('iframe')!
  // Remounted: a NEW iframe element (the `key` bumped) — not the same node that already loaded.
  expect(iframe2).not.toBe(iframe1)
  // Same src/sandbox/allow — refresh re-fetches the IDENTICAL url, no path/security change.
  expect(iframe2.getAttribute('src')).toBe('/preview/abc/')
  expect(iframe2.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-popups')
  expect(iframe2.getAttribute('allow')).toBe('clipboard-write')
  // `loaded` re-armed: the dark skeleton is back (iframe hidden) until the new load paints — no white flash.
  expect(iframe2.className).toMatch(/opacity-0/)
  expect(screen.getByText(/rendering|çiziliyor/i)).toBeInTheDocument()
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

// ── PREVIEW UNGATED FROM VERIFICATION (owner 2026-06-11): "if Proto wrote code, the user must ALWAYS
//    be able to preview it — Trace/Critic gate VERIFICATION + PUSH, never SEEING the app." The Run
//    affordance here is purely `onRun && canRun` (the studio derives canRun from CODE-PRESENCE + a
//    settled status, NOT from verification). These pin the panel's own contract: Run is offered for an
//    UNVERIFIED build with no live URL yet (the empty-state branch), the honest 'unverified' chip rides
//    alongside it, and Run is withheld only when the studio says !canRun. ──
test('offers ▶ Run in the empty-state when onRun && canRun (no live URL yet) — even UNVERIFIED', () => {
  renderI18n(
    <PreviewPanel view={viewWith(undefined, false)} device="responsive" onDevice={() => {}} onRun={() => {}} canRun />,
  )
  // Two surfaces carry the same control (header pill + empty-state CTA); both say "Run app".
  const runs = screen.getAllByRole('button', { name: /Run app|Uygulamayı çalıştır/i })
  expect(runs.length).toBe(2) // header pill + empty-state CTA — the contract the comment claims
})

test('keeps the honest "unverified" chip on an unverified preview (independent of Run/done)', () => {
  renderI18n(
    <PreviewPanel view={viewWith(undefined, false)} device="responsive" onDevice={() => {}} onRun={() => {}} canRun />,
  )
  // verified === false → the chip reads "unverified" (NOT "verified"); the Run path coexists with it.
  expect(screen.getByText(/^unverified$|^doğrulanmadı$/i)).toBeInTheDocument()
  expect(screen.queryByText(/^verified$|^doğrulandı$/i)).toBeNull()
})

test('shows the "verified" chip only when view.verified === true', () => {
  renderI18n(
    <PreviewPanel view={viewWith('/preview/abc/', true)} device="responsive" onDevice={() => {}} onRun={() => {}} canRun />,
  )
  expect(screen.getByText(/^verified$|^doğrulandı$/i)).toBeInTheDocument()
})

test('withholds ▶ Run when !canRun (studio gates the boot affordance, not the panel)', () => {
  renderI18n(
    <PreviewPanel view={viewWith(undefined, false)} device="responsive" onDevice={() => {}} onRun={() => {}} canRun={false} />,
  )
  expect(screen.queryByRole('button', { name: /Run app|Uygulamayı çalıştır/i })).toBeNull()
})

// ── A3.3 — STALE APP AFTER A REBUILD: the preview url is ALWAYS /preview/:id/ (stable across
//    rebuilds), so keying the iframe by url/reloadNonce alone never remounts it when a change
//    request's restart emits a fresh 'ready'. The folded `preview.epoch` (bumped per ready fold)
//    now joins the key, so EVERY fresh ready remounts the iframe and re-fetches the NEW bytes. ──
const pvEv = (status: 'starting' | 'ready' | 'stopped', url?: string): AkisEvent =>
  ({ kind: 'preview_status', status, ...(url !== undefined ? { url } : {}), agent: 'orchestrator', laneId: 'main', sessionId: 's1', ts: 0 }) as AkisEvent

const panelFor = (view: SessionView): ReactElement =>
  <PreviewPanel view={view} device="responsive" onDevice={() => {}} onRun={() => {}} canRun />

test('A3.3: two CONSECUTIVE ready folds at the SAME url remount the iframe (epoch bump, no intervening frame)', () => {
  const URLP = '/preview/s1/'
  const v1 = foldSessionView('s1', [pvEv('ready', URLP)])
  const { container, rerender } = renderI18n(panelFor(v1))
  const iframe1 = container.querySelector('iframe')!
  expect(iframe1).not.toBeNull()
  fireEvent.load(iframe1) // the old document painted — skeleton gone
  expect(iframe1.className).toMatch(/opacity-100/)

  // A rebuild's restart emits a SECOND ready at the SAME url (coalescing may hide any
  // intermediate frame) — the fold bumps epoch, the panel must remount (new bytes).
  const v2 = foldSessionView('s1', [pvEv('ready', URLP), pvEv('ready', URLP)])
  rerender(<I18nProvider>{panelFor(v2)}</I18nProvider>)
  const iframe2 = container.querySelector('iframe')!
  expect(iframe2).not.toBe(iframe1) // a NEW node — the document re-fetches
  expect(iframe2.getAttribute('src')).toBe(URLP) // same src/sandbox — no path/security change
  expect(iframe2.className).toMatch(/opacity-0/) // the loading skeleton re-armed
  expect(screen.getByText(/rendering|çiziliyor/i)).toBeInTheDocument()
})

test('A3.3: ready → non-ready → ready at the SAME url yields a NEW iframe node and re-arms the skeleton', () => {
  const URLP = '/preview/s1/'
  const v1 = foldSessionView('s1', [pvEv('ready', URLP)])
  const { container, rerender } = renderI18n(panelFor(v1))
  const iframe1 = container.querySelector('iframe')!
  fireEvent.load(iframe1)

  // The restart's 'starting' frame drops the url → the iframe unmounts (spinner branch).
  const v2 = foldSessionView('s1', [pvEv('ready', URLP), pvEv('starting')])
  rerender(<I18nProvider>{panelFor(v2)}</I18nProvider>)
  expect(container.querySelector('iframe')).toBeNull()

  // The fresh 'ready' at the SAME url: a NEW iframe node, skeleton up until it paints.
  const v3 = foldSessionView('s1', [pvEv('ready', URLP), pvEv('starting'), pvEv('ready', URLP)])
  rerender(<I18nProvider>{panelFor(v3)}</I18nProvider>)
  const iframe3 = container.querySelector('iframe')!
  expect(iframe3).not.toBeNull()
  expect(iframe3).not.toBe(iframe1)
  expect(iframe3.className).toMatch(/opacity-0/)
  expect(screen.getByText(/rendering|çiziliyor/i)).toBeInTheDocument()
})
