import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerPreviewRoutes } from '../../src/api/preview.routes.js'
import { PreviewRegistry } from '../../src/preview/PreviewRegistry.js'
import { MockSessionStore } from '../../src/store/MockSessionStore.js'
import { EventBus } from '../../src/events/bus.js'
import { initialSession } from '@akis/shared'
import type { Sandbox, RunResult } from '../../src/exec/Sandbox.js'

const okSandbox: Sandbox = { async run(): Promise<RunResult> { return { code: 0, stdout: '', stderr: '', timedOut: false } } }

let app: FastifyInstance | undefined
let upstream: http.Server | undefined
afterEach(async () => { await app?.close(); app = undefined; await new Promise<void>(r => upstream ? upstream.close(() => r()) : r()); upstream = undefined })

function build(opts: { portFor?: (id: string) => number | undefined; withCode?: boolean } = {}) {
  const store = new MockSessionStore()
  const bus = new EventBus()
  const registry = new PreviewRegistry({ sandbox: okSandbox })
  const a = Fastify({ logger: false })
  registerPreviewRoutes(a, { registry, store, bus, ...(opts.portFor ? { portFor: opts.portFor } : {}) })
  return { a, store, bus, registry }
}

describe('preview routes', () => {
  it('POST /preview → 404 unknown session, 409 when no code', async () => {
    const { a, store } = build()
    app = a
    expect((await a.inject({ method: 'POST', url: '/sessions/nope/preview' })).statusCode).toBe(404)
    await store.create(initialSession('s1', 'idea'))
    expect((await a.inject({ method: 'POST', url: '/sessions/s1/preview' })).statusCode).toBe(409)
  })

  it('GET /preview → 404 when none registered', async () => {
    const { a } = build(); app = a
    expect((await a.inject({ method: 'GET', url: '/sessions/s1/preview' })).statusCode).toBe(404)
  })

  it('proxies /preview/:id/* to the running upstream (no browser)', async () => {
    // A real ephemeral upstream stands in for the running preview app.
    upstream = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`upstream:${req.url}`) })
    await new Promise<void>(r => upstream!.listen(0, '127.0.0.1', r))
    const port = (upstream.address() as AddressInfo).port

    const { a } = build({ portFor: () => port })
    app = a
    await a.listen({ port: 0, host: '127.0.0.1' })
    const base = `http://127.0.0.1:${(a.server.address() as AddressInfo).port}`
    const res = await fetch(`${base}/preview/s1/foo/bar`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('upstream:/foo/bar')
  })

  it('proxy → 404 when no running preview', async () => {
    const { a } = build({ portFor: () => undefined })
    app = a
    await a.listen({ port: 0, host: '127.0.0.1' })
    const base = `http://127.0.0.1:${(a.server.address() as AddressInfo).port}`
    expect((await fetch(`${base}/preview/s1/`)).status).toBe(404)
  })
})
