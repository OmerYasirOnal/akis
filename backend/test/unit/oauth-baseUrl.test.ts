import { describe, it, expect } from 'vitest'
import type { FastifyRequest } from 'fastify'
import { baseUrl } from '../../src/api/oauth.routes.js'

/**
 * FR-oauth-signin-20 / NFR-15 — `baseUrl()` is the SOLE source of the redirect_uri and the
 * post-login redirect origin, so its precedence + normalization is security-relevant:
 *  1. PUBLIC_BASE_URL wins (it is the origin REGISTERED with the OAuth app), trailing slashes stripped.
 *  2. Only when PUBLIC_BASE_URL is unset do we derive from the (client-controlled) forwarded/host
 *     headers — x-forwarded-proto/-host, then Host.
 *  3. Default 127.0.0.1:3000 (http) when nothing identifies the origin.
 * A regression that stopped stripping the trailing slash (→ a `//login` redirect / mismatched
 * redirect_uri) or that let a forwarded header override an explicit PUBLIC_BASE_URL would fail here.
 */

/** Minimal FastifyRequest stand-in: baseUrl only reads `.headers`. */
const reqWith = (headers: Record<string, string | undefined>): FastifyRequest =>
  ({ headers } as unknown as FastifyRequest)

describe('baseUrl (oauth/connect origin derivation)', () => {
  it('prefers PUBLIC_BASE_URL and strips any trailing slash(es)', () => {
    expect(baseUrl(reqWith({}), { PUBLIC_BASE_URL: 'https://akisflow.com/' })).toBe('https://akisflow.com')
    expect(baseUrl(reqWith({}), { PUBLIC_BASE_URL: 'https://akisflow.com///' })).toBe('https://akisflow.com')
    expect(baseUrl(reqWith({}), { PUBLIC_BASE_URL: 'https://akisflow.com' })).toBe('https://akisflow.com')
  })

  it('PUBLIC_BASE_URL overrides forwarded headers (registered origin, never client-controlled)', () => {
    const req = reqWith({ 'x-forwarded-proto': 'http', 'x-forwarded-host': 'evil.example', host: 'evil.example' })
    expect(baseUrl(req, { PUBLIC_BASE_URL: 'https://akisflow.com/' })).toBe('https://akisflow.com')
  })

  it('derives from x-forwarded-proto + x-forwarded-host when PUBLIC_BASE_URL is unset', () => {
    const req = reqWith({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'localhost:5173' })
    expect(baseUrl(req, {})).toBe('https://localhost:5173')
  })

  it('falls back to the Host header (default proto http) when no forwarded headers are present', () => {
    expect(baseUrl(reqWith({ host: 'localhost:5173' }), {})).toBe('http://localhost:5173')
  })

  it('defaults to 127.0.0.1:3000 over http when neither PUBLIC_BASE_URL nor any host header exists', () => {
    expect(baseUrl(reqWith({}), {})).toBe('http://127.0.0.1:3000')
  })
})
