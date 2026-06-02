import { describe, it, expect } from 'vitest'
import { resolveListenHost } from '../../src/api/server.js'

/**
 * HOST bind safety: the default stays loopback (dev safety — never auto-expose), but a
 * container/host can set HOST=0.0.0.0 to serve on all interfaces. The log string must
 * report the host actually bound, not a hard-coded 127.0.0.1.
 */
describe('resolveListenHost', () => {
  it('defaults to loopback (127.0.0.1) when HOST is unset', () => {
    expect(resolveListenHost({})).toBe('127.0.0.1')
  })

  it('uses an explicit HOST (e.g. the container 0.0.0.0)', () => {
    expect(resolveListenHost({ HOST: '0.0.0.0' })).toBe('0.0.0.0')
  })

  it('an empty HOST falls back to loopback (treated as unset)', () => {
    expect(resolveListenHost({ HOST: '' })).toBe('127.0.0.1')
  })
})
