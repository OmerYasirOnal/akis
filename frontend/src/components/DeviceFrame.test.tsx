/**
 * DeviceFrame — device toggle + iframe logical width
 * WHY: pin the width contracts (responsive=100%, mobile=390px, tablet=768px,
 * desktop=capped at paneWidth), the rotate width↔height swap (portrait↔landscape), and the
 * visibility rules (toggle hidden unless tab==="preview"; rotate only for mobile/tablet).
 */
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { beforeEach, vi } from 'vitest'
import { I18nProvider } from '../i18n/I18nContext.js'
import {
  DeviceFrame, DEVICE_WIDTHS, DEVICE_HEIGHTS,
  CUSTOM_MIN_PX, CUSTOM_MAX_PX, CUSTOM_WIDTH_KEY, clampCustomWidth,
} from './DeviceFrame.js'

// Inline renderI18n — same pattern as CopyButton.test.tsx; no shared helper yet.
const renderI18n = (ui: ReactElement) => render(<I18nProvider>{ui}</I18nProvider>)

const rotateBtn = () => screen.getByRole('button', { name: /rotate|döndür/i })
// The fluid drag-to-resize handle exposes itself as an ARIA slider (P2.4).
const widthSlider = () => screen.getByRole('slider', { name: /custom width|özel genişlik/i })

// DeviceFrame persists the last custom width to localStorage — isolate every test.
beforeEach(() => { try { localStorage.clear() } catch { /* jsdom no-store */ } })

test('mobile preset sets a 390px logical width on the frame', () => {
  renderI18n(<DeviceFrame device="mobile" paneWidth={900} onDevice={() => {}} tab="preview"><iframe title="x" /></DeviceFrame>)
  const frame = screen.getByTestId('device-frame')
  expect(frame.style.width).toBe('390px')
})

test('tablet preset sets a 768px logical width on the frame', () => {
  renderI18n(<DeviceFrame device="tablet" paneWidth={900} onDevice={() => {}} tab="preview"><iframe title="x" /></DeviceFrame>)
  expect(screen.getByTestId('device-frame').style.width).toBe('768px')
})

test('responsive preset is full width', () => {
  renderI18n(<DeviceFrame device="responsive" paneWidth={900} onDevice={() => {}} tab="preview"><iframe title="x" /></DeviceFrame>)
  expect(screen.getByTestId('device-frame').style.width).toBe('100%')
})

test('device toggle is hidden unless the active tab is preview (M4)', () => {
  renderI18n(<DeviceFrame device="responsive" paneWidth={900} onDevice={() => {}} tab="code"><iframe title="x" /></DeviceFrame>)
  expect(screen.queryByRole('group', { name: /preview width|önizleme genişliği/i })).toBeNull()
})

test('desktop preset caps width at paneWidth when paneWidth < 1280', () => {
  renderI18n(<DeviceFrame device="desktop" paneWidth={800} onDevice={() => {}} tab="preview"><iframe title="x" /></DeviceFrame>)
  // min(1280, 800) = 800
  expect(screen.getByTestId('device-frame').style.width).toBe('800px')
})

test('desktop preset uses 1280px when paneWidth >= 1280', () => {
  renderI18n(<DeviceFrame device="desktop" paneWidth={1600} onDevice={() => {}} tab="preview"><iframe title="x" /></DeviceFrame>)
  expect(screen.getByTestId('device-frame').style.width).toBe('1280px')
})

test('toggle buttons render with aria-pressed (one per preset) when tab is preview', () => {
  renderI18n(<DeviceFrame device="mobile" paneWidth={900} onDevice={() => {}} tab="preview"><iframe title="x" /></DeviceFrame>)
  const buttons = screen.getAllByRole('button')
  // four preset buttons + the rotate button (mobile is rotatable) all carry aria-pressed
  expect(buttons.length).toBeGreaterThanOrEqual(4)
  // exactly one DEVICE preset is pressed (rotate starts unpressed in portrait)
  const presetButtons = buttons.filter(b => /responsive|mobile|tablet|desktop|esnek|mobil|masaüstü/i.test(b.getAttribute('aria-label') ?? ''))
  const pressed = presetButtons.filter(b => b.getAttribute('aria-pressed') === 'true')
  expect(pressed).toHaveLength(1)
})

test('children are rendered verbatim inside the frame', () => {
  renderI18n(<DeviceFrame device="responsive" paneWidth={900} onDevice={() => {}} tab="preview"><iframe title="my-frame" /></DeviceFrame>)
  expect(screen.getByTitle('my-frame')).toBeInTheDocument()
})

test('DEVICE_WIDTHS exports correct preset values', () => {
  expect(DEVICE_WIDTHS.responsive).toBeNull()
  expect(DEVICE_WIDTHS.mobile).toBe(390)
  expect(DEVICE_WIDTHS.tablet).toBe(768)
  expect(DEVICE_WIDTHS.desktop).toBe(1280)
})

test('DEVICE_HEIGHTS exports landscape long-edge for rotatable presets only', () => {
  expect(DEVICE_HEIGHTS.mobile).toBe(844)
  expect(DEVICE_HEIGHTS.tablet).toBe(1024)
  // responsive/desktop never rotate → no entry
  expect(DEVICE_HEIGHTS.responsive).toBeUndefined()
  expect(DEVICE_HEIGHTS.desktop).toBeUndefined()
})

// ── Rotate ────────────────────────────────────────────────────────────────────

test('rotate control is hidden for responsive and desktop', () => {
  const { rerender } = renderI18n(<DeviceFrame device="responsive" paneWidth={900} onDevice={() => {}} tab="preview"><iframe title="x" /></DeviceFrame>)
  expect(screen.queryByRole('button', { name: /rotate|döndür/i })).toBeNull()
  rerender(<I18nProvider><DeviceFrame device="desktop" paneWidth={900} onDevice={() => {}} tab="preview"><iframe title="x" /></DeviceFrame></I18nProvider>)
  expect(screen.queryByRole('button', { name: /rotate|döndür/i })).toBeNull()
})

test('rotate control is shown for mobile and tablet', () => {
  const { rerender } = renderI18n(<DeviceFrame device="mobile" paneWidth={900} onDevice={() => {}} tab="preview"><iframe title="x" /></DeviceFrame>)
  expect(screen.getByRole('button', { name: /rotate|döndür/i })).toBeInTheDocument()
  rerender(<I18nProvider><DeviceFrame device="tablet" paneWidth={900} onDevice={() => {}} tab="preview"><iframe title="x" /></DeviceFrame></I18nProvider>)
  expect(screen.getByRole('button', { name: /rotate|döndür/i })).toBeInTheDocument()
})

test('rotating mobile swaps 390×844 → 844 logical width and toggles aria-pressed', () => {
  renderI18n(<DeviceFrame device="mobile" paneWidth={1200} onDevice={() => {}} tab="preview"><iframe title="x" /></DeviceFrame>)
  const frame = screen.getByTestId('device-frame')
  expect(frame.style.width).toBe('390px')
  expect(rotateBtn().getAttribute('aria-pressed')).toBe('false')
  fireEvent.click(rotateBtn())
  expect(frame.style.width).toBe('844px')
  expect(rotateBtn().getAttribute('aria-pressed')).toBe('true')
})

test('rotating tablet swaps 768×1024 → 1024 logical width', () => {
  renderI18n(<DeviceFrame device="tablet" paneWidth={1400} onDevice={() => {}} tab="preview"><iframe title="x" /></DeviceFrame>)
  const frame = screen.getByTestId('device-frame')
  expect(frame.style.width).toBe('768px')
  fireEvent.click(rotateBtn())
  expect(frame.style.width).toBe('1024px')
})

test('landscape pixel badge reflects the rotated logical width', () => {
  renderI18n(<DeviceFrame device="mobile" paneWidth={1200} onDevice={() => {}} tab="preview"><iframe title="x" /></DeviceFrame>)
  fireEvent.click(rotateBtn())
  // badge shows "844 px"
  expect(screen.getByText(/844/)).toBeInTheDocument()
})

test('switching device resets orientation back to portrait', () => {
  const { rerender } = renderI18n(<DeviceFrame device="mobile" paneWidth={1400} onDevice={() => {}} tab="preview"><iframe title="x" /></DeviceFrame>)
  fireEvent.click(rotateBtn())
  expect(screen.getByTestId('device-frame').style.width).toBe('844px')
  // switch to tablet → orientation must reset to portrait (768px, NOT a carried-over landscape)
  rerender(<I18nProvider><DeviceFrame device="tablet" paneWidth={1400} onDevice={() => {}} tab="preview"><iframe title="x" /></DeviceFrame></I18nProvider>)
  expect(screen.getByTestId('device-frame').style.width).toBe('768px')
  expect(rotateBtn().getAttribute('aria-pressed')).toBe('false')
})

// ── P2.4 Fluid drag-to-resize custom width + live px readout ─────────────────────

test('clampCustomWidth clamps to [320, min(1280, paneWidth)] and floors at 320 on a narrow pane', () => {
  // roomy pane → 1280 cap binds
  expect(clampCustomWidth(2000, 1600)).toBe(CUSTOM_MAX_PX)
  expect(clampCustomWidth(100, 1600)).toBe(CUSTOM_MIN_PX)
  expect(clampCustomWidth(640, 1600)).toBe(640)
  // narrow pane (900) → the pane width caps below 1280
  expect(clampCustomWidth(2000, 900)).toBe(900)
  // sub-floor pane → the 320 floor still wins (custom never collapses below readable width)
  expect(clampCustomWidth(2000, 200)).toBe(CUSTOM_MIN_PX)
  expect(clampCustomWidth(50, 200)).toBe(CUSTOM_MIN_PX)
})

test('the custom-width slider exists with role + aria-value{now,min,max} when tab is preview', () => {
  renderI18n(<DeviceFrame device="responsive" paneWidth={1024} onDevice={() => {}} tab="preview"><iframe title="x" /></DeviceFrame>)
  const slider = widthSlider()
  expect(slider.getAttribute('aria-valuemin')).toBe(String(CUSTOM_MIN_PX))
  // aria-valuemax tracks the live cap = min(1280, paneWidth)
  expect(slider.getAttribute('aria-valuemax')).toBe('1024')
  expect(slider.getAttribute('aria-valuenow')).toBeTruthy()
})

test('the width slider is hidden unless the active tab is preview', () => {
  renderI18n(<DeviceFrame device="responsive" paneWidth={1024} onDevice={() => {}} tab="code"><iframe title="x" /></DeviceFrame>)
  expect(screen.queryByRole('slider', { name: /custom width|özel genişlik/i })).toBeNull()
})

test('keyboard ArrowRight on the slider switches to custom mode and widens the logical width + readout', () => {
  const onDevice = vi.fn()
  // device='custom' lets the frame render the custom px width; start from a known persisted width.
  localStorage.setItem(CUSTOM_WIDTH_KEY, '640')
  renderI18n(<DeviceFrame device="custom" paneWidth={1280} onDevice={onDevice} tab="preview"><iframe title="x" /></DeviceFrame>)
  const frame = screen.getByTestId('device-frame')
  expect(frame.style.width).toBe('640px')
  fireEvent.keyDown(widthSlider(), { key: 'ArrowRight' })
  // width grew by the keyboard step (and stayed an integer px)
  const after = parseInt(frame.style.width, 10)
  expect(after).toBeGreaterThan(640)
  // the px readout reflects the new width
  expect(screen.getByText(new RegExp(`${after}\\b`))).toBeInTheDocument()
})

test('Home/End on the slider jump to the clamped min/max width', () => {
  renderI18n(<DeviceFrame device="custom" paneWidth={1024} onDevice={() => {}} tab="preview"><iframe title="x" /></DeviceFrame>)
  const frame = screen.getByTestId('device-frame')
  fireEvent.keyDown(widthSlider(), { key: 'End' })
  // End → max = min(1280, paneWidth=1024) = 1024
  expect(frame.style.width).toBe('1024px')
  fireEvent.keyDown(widthSlider(), { key: 'Home' })
  expect(frame.style.width).toBe(`${CUSTOM_MIN_PX}px`)
})

test('a resize from a PRESET nudges off the preset width, opts into custom mode, and persists', () => {
  const onDevice = vi.fn()
  // From the mobile preset (390px), an Arrow nudges off 390 (NOT a stale stored value) into custom.
  renderI18n(<DeviceFrame device="mobile" paneWidth={1280} onDevice={onDevice} tab="preview"><iframe title="x" /></DeviceFrame>)
  fireEvent.keyDown(widthSlider(), { key: 'ArrowRight' })
  // keying the slider opts into custom mode via onDevice
  expect(onDevice).toHaveBeenCalledWith('custom')
  // the new width is persisted for a later tab flip (390 + the 16px step)
  expect(Number(localStorage.getItem(CUSTOM_WIDTH_KEY))).toBe(406)
})

test('picking a named preset still works and the readout reflects the preset width (not custom)', () => {
  const onDevice = vi.fn()
  renderI18n(<DeviceFrame device="tablet" paneWidth={1280} onDevice={onDevice} tab="preview"><iframe title="x" /></DeviceFrame>)
  // tablet preset → 768 readout, the slider's aria-valuenow tracks the active logical width
  expect(screen.getByText(/768/)).toBeInTheDocument()
  expect(widthSlider().getAttribute('aria-valuenow')).toBe('768')
})

test('a resize NEVER touches the iframe src/sandbox (logical width only)', () => {
  localStorage.setItem(CUSTOM_WIDTH_KEY, '600')
  renderI18n(
    <DeviceFrame device="custom" paneWidth={1280} onDevice={() => {}} tab="preview">
      <iframe title="app" src="/preview/abc/" sandbox="allow-scripts allow-forms allow-popups" />
    </DeviceFrame>,
  )
  const iframe = screen.getByTitle('app')
  const srcBefore = iframe.getAttribute('src')
  const sandboxBefore = iframe.getAttribute('sandbox')
  fireEvent.keyDown(widthSlider(), { key: 'ArrowRight' })
  fireEvent.keyDown(widthSlider(), { key: 'End' })
  expect(iframe.getAttribute('src')).toBe(srcBefore)
  expect(iframe.getAttribute('sandbox')).toBe(sandboxBefore)
})

test('the persisted custom width survives a remount (tab flip)', () => {
  localStorage.setItem(CUSTOM_WIDTH_KEY, '720')
  const { unmount } = renderI18n(<DeviceFrame device="custom" paneWidth={1280} onDevice={() => {}} tab="preview"><iframe title="x" /></DeviceFrame>)
  expect(screen.getByTestId('device-frame').style.width).toBe('720px')
  unmount()
  renderI18n(<DeviceFrame device="custom" paneWidth={1280} onDevice={() => {}} tab="preview"><iframe title="x" /></DeviceFrame>)
  expect(screen.getByTestId('device-frame').style.width).toBe('720px')
})

test('a custom width above the live cap re-clamps when the pane narrows', () => {
  localStorage.setItem(CUSTOM_WIDTH_KEY, '1100')
  const { rerender } = renderI18n(<DeviceFrame device="custom" paneWidth={1280} onDevice={() => {}} tab="preview"><iframe title="x" /></DeviceFrame>)
  expect(screen.getByTestId('device-frame').style.width).toBe('1100px')
  // pane shrinks below the stored width → frame re-clamps to the new cap, never overflows
  rerender(<I18nProvider><DeviceFrame device="custom" paneWidth={800} onDevice={() => {}} tab="preview"><iframe title="x" /></DeviceFrame></I18nProvider>)
  expect(screen.getByTestId('device-frame').style.width).toBe('800px')
})
