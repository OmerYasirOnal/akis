/**
 * DeviceFrame — device toggle + iframe logical width
 * WHY: pin the width contracts (responsive=100%, mobile=390px, tablet=768px,
 * desktop=capped at paneWidth), the rotate width↔height swap (portrait↔landscape), and the
 * visibility rules (toggle hidden unless tab==="preview"; rotate only for mobile/tablet).
 */
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { I18nProvider } from '../i18n/I18nContext.js'
import { DeviceFrame, DEVICE_WIDTHS, DEVICE_HEIGHTS } from './DeviceFrame.js'

// Inline renderI18n — same pattern as CopyButton.test.tsx; no shared helper yet.
const renderI18n = (ui: ReactElement) => render(<I18nProvider>{ui}</I18nProvider>)

const rotateBtn = () => screen.getByRole('button', { name: /rotate|döndür/i })

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
