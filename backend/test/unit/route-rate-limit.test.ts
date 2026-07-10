import { describe, it, expect } from 'vitest'
import { resolveRouteRateLimits, rateLimitKey, overRouteLimit } from '../../src/usage/rateLimit.js'
import type { FastifyReply, FastifyRequest } from 'fastify'

/** A minimal fake reply capturing the 429 shape + retry-after header. */
function fakeReply() {
  const state: { code?: number; body?: unknown; headers: Record<string, string> } = { headers: {} }
  const reply = {
    header(k: string, v: string) { state.headers[k.toLowerCase()] = v; return reply },
    code(c: number) { state.code = c; return reply },
    send(b: unknown) { state.body = b; return reply },
  }
  return { reply: reply as unknown as FastifyReply, state }
}
const req = (ip: string) => ({ ip } as FastifyRequest)

describe('resolveRouteRateLimits (env, opt-in)', () => {
  it('DEFAULT (unset) ⇒ undefined — the layer is off, dep omitted, byte-identical', () => {
    expect(resolveRouteRateLimits({})).toBeUndefined()
    expect(resolveRouteRateLimits({ AKIS_RATE_LIMIT: '0' })).toBeUndefined()
    expect(resolveRouteRateLimits({ AKIS_RATE_LIMIT: 'false' })).toBeUndefined()
  })

  it('AKIS_RATE_LIMIT truthy ⇒ the three buckets exist with sane defaults', () => {
    for (const on of ['1', 'true', 'on', 'TRUE']) {
      const r = resolveRouteRateLimits({ AKIS_RATE_LIMIT: on })
      expect(r, on).toBeDefined()
      expect(r!.build).toBeDefined()
      expect(r!.chat).toBeDefined()
      expect(r!.externalWrite).toBeDefined()
    }
  })

  it('a per-bucket env override changes the cap (build max = 2)', () => {
    const r = resolveRouteRateLimits({ AKIS_RATE_LIMIT: '1', AKIS_RATE_LIMIT_BUILD_MAX: '2' })!
    const k = 'u1'
    expect(r.build.hit(k)).toBeUndefined()
    expect(r.build.hit(k)).toBeUndefined()
    expect(typeof r.build.hit(k)).toBe('number') // 3rd over the cap of 2
  })
})

describe('rateLimitKey', () => {
  it('prefers the ownerId (per-account) when present', () => {
    expect(rateLimitKey(req('1.2.3.4'), 'owner-1')).toBe('u:owner-1')
  })
  it('falls back to the IP (per-anon) when unauthenticated', () => {
    expect(rateLimitKey(req('1.2.3.4'), undefined)).toBe('ip:1.2.3.4')
    expect(rateLimitKey({ } as FastifyRequest, undefined)).toBe('ip:unknown')
  })
  it('an authed owner and an anon from the same IP get DIFFERENT keys (no cross-bucket bleed)', () => {
    expect(rateLimitKey(req('1.2.3.4'), 'owner-1')).not.toBe(rateLimitKey(req('1.2.3.4'), undefined))
  })
})

describe('overRouteLimit', () => {
  it('under the cap ⇒ false, no 429 written', () => {
    const r = resolveRouteRateLimits({ AKIS_RATE_LIMIT: '1', AKIS_RATE_LIMIT_BUILD_MAX: '5' })!
    const { reply, state } = fakeReply()
    expect(overRouteLimit(r.build, 'u1', reply)).toBe(false)
    expect(state.code).toBeUndefined()
  })

  it('at the cap ⇒ true + a clean 429 {code:RateLimited,retryAfter} + retry-after header', () => {
    const r = resolveRouteRateLimits({ AKIS_RATE_LIMIT: '1', AKIS_RATE_LIMIT_BUILD_MAX: '1' })!
    const { reply, state } = fakeReply()
    expect(overRouteLimit(r.build, 'u1', reply)).toBe(false) // 1st allowed
    expect(overRouteLimit(r.build, 'u1', reply)).toBe(true)  // 2nd over cap
    expect(state.code).toBe(429)
    expect((state.body as { code: string }).code).toBe('RateLimited')
    expect((state.body as { retryAfter: number }).retryAfter).toBeGreaterThan(0)
    expect(state.headers['retry-after']).toBeTruthy()
  })

  it('two different keys have independent windows', () => {
    const r = resolveRouteRateLimits({ AKIS_RATE_LIMIT: '1', AKIS_RATE_LIMIT_BUILD_MAX: '1' })!
    const a = fakeReply(); const b = fakeReply()
    expect(overRouteLimit(r.build, 'a', a.reply)).toBe(false)
    expect(overRouteLimit(r.build, 'b', b.reply)).toBe(false) // b's first hit is independent of a
  })
})
