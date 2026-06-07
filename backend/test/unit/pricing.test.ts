import { describe, it, expect } from 'vitest'
import { estimateCostUsd, MODEL_PRICING, MODEL_PRICING_DATED } from '@akis/shared'

describe('estimateCostUsd (audit #16 — analytics cost estimate)', () => {
  it('prices a known model from its per-1M input/output rates', () => {
    // Opus 4.8: $5/1M in, $25/1M out → 1M in + 1M out = $30.
    expect(estimateCostUsd('claude-opus-4-8', 1_000_000, 1_000_000)).toEqual({ usd: 30, known: true })
    // Haiku: $1/1M in, $5/1M out → 500k in + 200k out = 0.5 + 1.0 = $1.50.
    const r = estimateCostUsd('claude-haiku-4-5-20251001', 500_000, 200_000)
    expect(r.known).toBe(true)
    expect(r.usd).toBeCloseTo(1.5, 6)
  })

  it('an UNKNOWN or absent model returns known:false (the UI dashes, never a fabricated $0)', () => {
    expect(estimateCostUsd('some-unlisted-model', 1000, 1000)).toEqual({ usd: 0, known: false })
    expect(estimateCostUsd(undefined, 1000, 1000)).toEqual({ usd: 0, known: false })
  })

  it('the price table is DATED + every entry has both rates (so a partial entry can never mis-price)', () => {
    expect(MODEL_PRICING_DATED).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    for (const [, p] of Object.entries(MODEL_PRICING)) {
      expect(typeof p.inUsdPer1M).toBe('number')
      expect(typeof p.outUsdPer1M).toBe('number')
    }
  })
})
