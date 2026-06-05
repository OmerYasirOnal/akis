import { describe, it, expect } from 'vitest'
import { fmtTokens, fmtDuration, metricsBadge } from './metricsFormat.js'
import { STRINGS } from '../i18n/catalog.js'
import type { StringKey } from '../i18n/catalog.js'

// A real EN `t` so singular/plural + the tok label resolve exactly as in the app.
const t = (k: StringKey): string => STRINGS.en[k] ?? k

describe('fmtTokens', () => {
  it('renders <1000 as the raw count', () => {
    expect(fmtTokens(0)).toBe('0')
    expect(fmtTokens(42)).toBe('42')
    expect(fmtTokens(999)).toBe('999')
  })
  it('renders ≥1000 k-style with one decimal', () => {
    expect(fmtTokens(1000)).toBe('1.0k')
    expect(fmtTokens(12345)).toBe('12.3k')
    expect(fmtTokens(1500)).toBe('1.5k')
  })
})

describe('fmtDuration', () => {
  it('renders <60s as seconds', () => {
    expect(fmtDuration(0)).toBe('0s')
    expect(fmtDuration(42_000)).toBe('42s')
    expect(fmtDuration(59_400)).toBe('59s')
  })
  it('renders ≥60s as "Xm Ys"', () => {
    expect(fmtDuration(60_000)).toBe('1m 0s')
    expect(fmtDuration(93_000)).toBe('1m 33s')
  })
})

describe('metricsBadge', () => {
  it('builds "tok · tool · time" with present usage and a single tool (singular)', () => {
    const b = metricsBadge(t, { usage: { inTokens: 8000, outTokens: 4345 }, toolCalls: 1, durationMs: 42_000 })
    expect(b).toBe('12.3k tok · 1 tool · 42s')
  })
  it('pluralizes the tool label for >1', () => {
    const b = metricsBadge(t, { usage: { inTokens: 500, outTokens: 0 }, toolCalls: 3, durationMs: 1_000 })
    expect(b).toBe('500 tok · 3 tools · 1s')
  })
  it('OMITS the tok segment when usage is absent — never a fabricated "0 tok"', () => {
    const b = metricsBadge(t, { toolCalls: 1, durationMs: 42_000 })
    expect(b).toBe('1 tool · 42s')
    expect(b).not.toContain('tok')
  })
  it('omits the tool segment when toolCalls is 0', () => {
    const b = metricsBadge(t, { durationMs: 1_000, toolCalls: 0 })
    expect(b).toBe('1s')
  })
  it('returns undefined when there is NEITHER usage NOR durationMs', () => {
    expect(metricsBadge(t, { toolCalls: 2 })).toBeUndefined()
    expect(metricsBadge(t, {})).toBeUndefined()
  })
})
