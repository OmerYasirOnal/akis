import { describe, it, expect } from 'vitest'
import { HttpMetrics } from '../../src/analytics/HttpMetrics.js'

describe('HttpMetrics — status-class counters + error rate', () => {
  it('starts empty with a 0 error rate (never NaN)', () => {
    const m = new HttpMetrics()
    expect(m.snapshot()).toEqual({ total: 0, ok: 0, redirect: 0, clientError: 0, serverError: 0, tooManyRequests: 0, errorRate: 0 })
  })

  it('buckets responses by status class', () => {
    const m = new HttpMetrics()
    for (const s of [200, 201, 204]) m.observe(s)
    m.observe(302)
    for (const s of [400, 404, 409]) m.observe(s)
    m.observe(500); m.observe(502)
    const s = m.snapshot()
    expect(s.ok).toBe(3)
    expect(s.redirect).toBe(1)
    expect(s.clientError).toBe(3)
    expect(s.serverError).toBe(2)
    expect(s.total).toBe(9)
  })

  it('counts 429 separately (rate/quota/concurrency refusals) while ALSO counting it as a 4xx', () => {
    const m = new HttpMetrics()
    m.observe(429); m.observe(429); m.observe(200)
    const s = m.snapshot()
    expect(s.tooManyRequests).toBe(2)
    expect(s.clientError).toBe(2) // 429 is still a client error
    expect(s.total).toBe(3)
  })

  it('errorRate = (4xx+5xx)/total, rounded to 3 decimals', () => {
    const m = new HttpMetrics()
    m.observe(200); m.observe(200); m.observe(500); m.observe(404) // 2 errors of 4
    expect(m.snapshot().errorRate).toBe(0.5)
  })

  it('ignores a non-numeric / out-of-range status defensively (never throws)', () => {
    const m = new HttpMetrics()
    expect(() => { m.observe(NaN); m.observe(0); m.observe(700) }).not.toThrow()
    // NaN/0/700 are not a recognized class → they still count toward total but no class bucket
    expect(m.snapshot().total).toBe(3)
    expect(m.snapshot().ok + m.snapshot().redirect + m.snapshot().clientError + m.snapshot().serverError).toBe(0)
  })
})
