/**
 * DeviceFrame — device toggle + iframe logical width
 * WHY: pin the three width contracts (responsive=100%, mobile=390px, desktop=capped at paneWidth)
 * and the visibility rule (toggle hidden unless tab==="preview").
 */
import { render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { I18nProvider } from '../i18n/I18nContext.js'
import { DeviceFrame, DEVICE_WIDTHS } from './DeviceFrame.js'

// Inline renderI18n — same pattern as CopyButton.test.tsx; no shared helper yet.
const renderI18n = (ui: ReactElement) => render(<I18nProvider>{ui}</I18nProvider>)

test('mobile preset sets a 390px logical width on the frame', () => {
  renderI18n(<DeviceFrame device="mobile" paneWidth={900} onDevice={() => {}} tab="preview"><iframe title="x" /></DeviceFrame>)
  const frame = screen.getByTestId('device-frame')
  expect(frame.style.width).toBe('390px')
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
  // all three preset buttons carry aria-pressed
  expect(buttons.length).toBeGreaterThanOrEqual(3)
  const pressed = buttons.filter(b => b.getAttribute('aria-pressed') === 'true')
  expect(pressed).toHaveLength(1)
})

test('children are rendered verbatim inside the frame', () => {
  renderI18n(<DeviceFrame device="responsive" paneWidth={900} onDevice={() => {}} tab="preview"><iframe title="my-frame" /></DeviceFrame>)
  expect(screen.getByTitle('my-frame')).toBeInTheDocument()
})

test('DEVICE_WIDTHS exports correct preset values', () => {
  expect(DEVICE_WIDTHS.responsive).toBeNull()
  expect(DEVICE_WIDTHS.mobile).toBe(390)
  expect(DEVICE_WIDTHS.desktop).toBe(1280)
})
