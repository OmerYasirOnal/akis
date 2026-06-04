import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { registerPreviewRoutes } from '../../src/api/preview.routes.js'
import type { PreviewRegistry } from '../../src/preview/PreviewRegistry.js'
import type { SessionStore } from '../../src/store/SessionStore.js'
import type { EventBus } from '../../src/events/bus.js'

/**
 * Regression for the LIVE-caught proxy bug: Fastify's JSON parser consumed the request
 * body before the proxy handler ran, so `req.raw.pipe(upstream)` forwarded ZERO bytes —
 * every body-carrying API call through `/preview/:id/*` hung until timeout (the generated
 * voting app's /api/signup answered 200 direct but 408'd through the proxy).
 *
 * REAL sockets on both sides (an echo upstream + a listening Fastify) — app.inject can't
 * exercise a hijacked, piped reply faithfully.
 */
describe('preview proxy forwards request BODIES (the live-caught POST hang)', () => {
  let upstream: Server
  let upstreamPort: number
  let app: FastifyInstance
  let proxyPort: number

  beforeAll(async () => {
    // Echo upstream: replies with the method + the EXACT body bytes it received.
    upstream = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', c => chunks.push(c))
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ method: req.method, echo: Buffer.concat(chunks).toString('utf8') }))
      })
    })
    await new Promise<void>(r => upstream.listen(0, '127.0.0.1', () => r()))
    upstreamPort = (upstream.address() as AddressInfo).port

    app = Fastify({ logger: false })
    registerPreviewRoutes(app, {
      registry: { staticDirFor: () => undefined } as unknown as PreviewRegistry,
      store: { get: async () => undefined } as unknown as SessionStore,
      bus: { emit: () => {} } as unknown as EventBus,
      portFor: () => upstreamPort,
    })
    await app.listen({ port: 0, host: '127.0.0.1' })
    proxyPort = (app.server.address() as AddressInfo).port
  })
  afterAll(async () => {
    await app.close()
    await new Promise<void>(r => upstream.close(() => r()))
  })

  it('POST json body arrives at the upstream INTACT (was: zero bytes → upstream hang)', async () => {
    const payload = JSON.stringify({ email: 'ada@x.test', password: 'hunter22' })
    const res = await fetch(`http://127.0.0.1:${proxyPort}/preview/s1/api/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
      signal: AbortSignal.timeout(5000), // the bug presented as an indefinite hang
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ method: 'POST', echo: payload })
  })

  it('non-JSON bodies pass through verbatim too (the passthrough parser never parses)', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/preview/s1/api/upload`, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: 'raw text Δ payload',
      signal: AbortSignal.timeout(5000),
    })
    expect(await res.json()).toEqual({ method: 'PUT', echo: 'raw text Δ payload' })
  })

  it('DELETE with NO body proxies cleanly (parser runs, empty stream)', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/preview/s1/api/items/1`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(5000),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ method: 'DELETE', echo: '' })
  })

  it('GET still proxies (no body; the raw fallback closes the upstream write side)', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/preview/s1/api/items`, { signal: AbortSignal.timeout(5000) })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ method: 'GET', echo: '' })
  })
})
