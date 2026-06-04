import { describe, it, expect } from 'vitest'
import { createRateLimiter } from '../../src/auth/rateLimit.js'

describe('createRateLimiter (sliding window, injectable clock)', () => {
  it('allows up to max within the window, then returns retry-after seconds', () => {
    let t = 0
    const rl = createRateLimiter({ max: 3, windowMs: 60_000, now: () => t })
    expect(rl.hit('ip1')).toBeUndefined()
    expect(rl.hit('ip1')).toBeUndefined()
    expect(rl.hit('ip1')).toBeUndefined()
    const retry = rl.hit('ip1')
    expect(retry).toBeGreaterThanOrEqual(1)
    expect(retry).toBeLessThanOrEqual(60)
  })

  it('the window SLIDES: old hits expire and capacity returns', () => {
    let t = 0
    const rl = createRateLimiter({ max: 2, windowMs: 10_000, now: () => t })
    rl.hit('k'); rl.hit('k')
    expect(rl.hit('k')).toBeDefined()      // full
    t = 10_001                              // first two hits fall out of the window
    expect(rl.hit('k')).toBeUndefined()     // capacity back
  })

  it('REJECTED attempts do not extend the lockout (the window drains while backing off)', () => {
    let t = 0
    const rl = createRateLimiter({ max: 1, windowMs: 10_000, now: () => t })
    rl.hit('k')
    for (let i = 0; i < 5; i++) { t += 1000; expect(rl.hit('k')).toBeDefined() }
    t = 10_001 // the single COUNTED hit (t=0) expired — rejections at t=1..5s did not re-arm it
    expect(rl.hit('k')).toBeUndefined()
  })

  it('keys are independent', () => {
    const rl = createRateLimiter({ max: 1, windowMs: 60_000, now: () => 0 })
    expect(rl.hit('a')).toBeUndefined()
    expect(rl.hit('b')).toBeUndefined()
    expect(rl.hit('a')).toBeDefined()
  })
})
