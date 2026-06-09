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
import type { TestEvidence } from '@akis/shared'

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

test('the nav + ship/inspect actions live in ONE labelled header cluster (back/forward/reload/pop-out/copy)', () => {
  renderPanel('/preview/abc/')
  // The actions are grouped in a single top-right cluster (a labelled group), not floating loose.
  // The cluster carries browser-style nav (back · forward · reload) plus pop-out + copy-URL.
  const cluster = screen.getByRole('group', { name: /preview actions|önizleme eylemleri/i })
  const within = (p: HTMLElement, name: RegExp) =>
    Array.from(p.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') || '').match(name))
  expect(within(cluster, /^back$|geri$/i)).toBeTruthy()
  expect(within(cluster, /forward|ileri/i)).toBeTruthy()
  expect(within(cluster, /reload|refresh preview|önizlemeyi yenile|yeniden yükle/i)).toBeTruthy()
  expect(within(cluster, /open in new tab|yeni sekmede aç/i)).toBeTruthy()
  expect(within(cluster, /copy url|url'yi kopyala/i)).toBeTruthy()
})

test('Back navigates the iframe history (contentWindow.history.back, best-effort under sandbox)', () => {
  const { container } = renderPanel('/preview/abc/')
  const iframe = container.querySelector('iframe')!
  // Stub a same-origin-ish history on contentWindow so we can observe the call (a real sandboxed
  // opaque-origin iframe would throw on access — the handler try/catches that as a graceful no-op).
  const back = vi.fn()
  const forward = vi.fn()
  Object.defineProperty(iframe, 'contentWindow', { value: { history: { back, forward } }, configurable: true })
  fireEvent.click(screen.getByRole('button', { name: /^back$|geri$/i }))
  expect(back).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: /forward|ileri/i }))
  expect(forward).toHaveBeenCalledTimes(1)
})

test('Back/Forward are a graceful no-op (no throw) when the sandboxed iframe blocks history access', () => {
  const { container } = renderPanel('/preview/abc/')
  const iframe = container.querySelector('iframe')!
  // Simulate the real cross-origin (opaque-origin) sandbox: reading .history throws a SecurityError.
  Object.defineProperty(iframe, 'contentWindow', {
    get() { return { get history(): never { throw new Error('SecurityError: cross-origin') } } },
    configurable: true,
  })
  // The click must not bubble the throw up (the handler swallows it) — assert no exception.
  expect(() => fireEvent.click(screen.getByRole('button', { name: /^back$|geri$/i }))).not.toThrow()
})

test('nav actions are HIDDEN for a non-/preview/ URL (no dead affordances)', () => {
  renderPanel('https://example.com/app')
  expect(screen.queryByRole('button', { name: /^back$|geri$/i })).toBeNull()
  expect(screen.queryByRole('button', { name: /forward|ileri/i })).toBeNull()
})

test('the Code tab is labelled with its language when known (e.g. TSX)', () => {
  const files = [{ filePath: 'App.tsx', content: 'export const A = () => null' }]
  renderI18n(
    <PreviewPanel view={viewWith('/preview/abc/')} device="responsive" onDevice={() => {}} files={files} />,
  )
  // The Code tab carries a subtle language badge; its accessible name still includes "Code"
  // (the badge is decorative) so the tab-honesty queries keep matching.
  const codeTab = screen.getByRole('tab', { name: /Code|Kod/ })
  expect(codeTab).toHaveTextContent(/TSX/)
})

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

// METRICS MOVE TO TRUST (owner feedback 2): the preview must show ONLY the tab switch + the active
// tab's content — NO bottom metrics row (Tests run / Result / Scenarios / p95). Those numbers belong
// in the GÜVEN (Trust) tab, which already carries Tests/Passed/Failed/Run time + the named scenarios.
const evidenceWith = (): TestEvidence => ({
  testsRun: 2,
  passed: true,
  durationMs: 1200,
  bdd: { built: 1, run: 1, passed: 1, failed: 0, skipped: 0, durationMs: 600 },
  e2e: { testsRun: 1, passed: true, expected: 1, unexpected: 0, flaky: 0, skipped: 0, durationMs: 600 },
  scenarios: [
    { suite: 'e2e', name: 'loads the home page', passed: true },
    { suite: 'bdd', name: 'submits the form', passed: true },
  ],
})

test('the Preview tab shows NO bottom metrics row (Tests run / p95 removed)', () => {
  renderI18n(
    <PreviewPanel view={viewWith('/preview/abc/')} device="responsive" onDevice={() => {}}
      files={[{ filePath: 'index.html', content: '<html/>' }]} testEvidence={evidenceWith()} />,
  )
  // The Preview tab is active by default; the old TestStats strip (Tests run / Result / Scenarios /
  // p95) must be gone entirely — the preview is just the tab switch + the running app.
  expect(screen.queryByText(/Tests run|Çalışan test/i)).toBeNull()
  expect(screen.queryByText(/^p95$/i)).toBeNull()
})

test('the metrics live in the Trust tab (Tests / Passed / Run time + scenarios)', () => {
  renderI18n(
    <PreviewPanel view={viewWith('/preview/abc/')} device="responsive" onDevice={() => {}}
      files={[{ filePath: 'index.html', content: '<html/>' }]} testEvidence={evidenceWith()} />,
  )
  // Flip to the Trust tab — the auditable evidence the preview's bottom row used to duplicate.
  fireEvent.click(screen.getByRole('tab', { name: /Trust|Güven/i }))
  expect(screen.getByText(/^Tests$|^Testler$/i)).toBeInTheDocument()
  expect(screen.getByText(/^Passed$|^Geçen$/i)).toBeInTheDocument()
  expect(screen.getByText(/Run time|Süre/i)).toBeInTheDocument()
  // The scenario evidence (the SCENARIOS metric, richer than a bare count) is listed by name.
  expect(screen.getByText('loads the home page')).toBeInTheDocument()
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
