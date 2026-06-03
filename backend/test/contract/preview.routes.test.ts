import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerPreviewRoutes, rewriteLocation } from '../../src/api/preview.routes.js'
import { PreviewRegistry } from '../../src/preview/PreviewRegistry.js'
import { MockSessionStore } from '../../src/store/MockSessionStore.js'
import { EventBus } from '../../src/events/bus.js'
import { initialSession } from '@akis/shared'
import type { Sandbox, RunResult } from '../../src/exec/Sandbox.js'

const okSandbox: Sandbox = { async run(): Promise<RunResult> { return { code: 0, stdout: '', stderr: '', timedOut: false } } }

let app: FastifyInstance | undefined
let upstream: http.Server | undefined
// Track every upstream socket so we can hard-destroy lingering tunnels (an open WS upgrade
// would otherwise keep app.close()/upstream.close() waiting forever).
const upstreamSockets = new Set<import('node:net').Socket>()
afterEach(async () => {
  for (const s of upstreamSockets) s.destroy()
  upstreamSockets.clear()
  await app?.close(); app = undefined
  await new Promise<void>(r => upstream ? upstream.close(() => r()) : r()); upstream = undefined
})

function track(server: http.Server): http.Server {
  server.on('connection', s => { upstreamSockets.add(s); s.on('close', () => upstreamSockets.delete(s)) })
  return server
}

function build(opts: { portFor?: (id: string) => number | undefined; withCode?: boolean } = {}) {
  const store = new MockSessionStore()
  const bus = new EventBus()
  const registry = new PreviewRegistry({ sandbox: okSandbox })
  // forceCloseConnections so a hijacked/upgraded socket can't wedge app.close() in teardown.
  const a = Fastify({ logger: false, forceCloseConnections: true })
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
    upstream = track(http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`upstream:${req.url}`) }))
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

  it('rewrites an upstream Location pointing at the loopback port back to /preview/:id/ (no port leak)', async () => {
    // Upstream redirects to its own loopback origin — the browser must never see 127.0.0.1:<port>.
    let port = 0
    upstream = track(http.createServer((_req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${port}/dashboard`, 'x-powered-by': 'upstream', te: 'trailers' }); res.end() }))
    await new Promise<void>(r => upstream!.listen(0, '127.0.0.1', r))
    port = (upstream.address() as AddressInfo).port

    const { a } = build({ portFor: () => port })
    app = a
    await a.listen({ port: 0, host: '127.0.0.1' })
    const base = `http://127.0.0.1:${(a.server.address() as AddressInfo).port}`
    const res = await fetch(`${base}/preview/s1/login`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/preview/s1/dashboard')
    expect(res.headers.get('x-powered-by')).toBe('upstream') // non-hop header forwarded
    expect(res.headers.get('te')).toBeNull()                 // hop-by-hop stripped
  })
})

describe('preview WebSocket upgrade tunnel (vite HMR)', () => {
  it('tunnels a /preview/:id/* upgrade to the loopback upstream and pipes both directions', async () => {
    // Upstream stands in for the running dev server: completes the upgrade then echoes.
    upstream = track(http.createServer())
    upstream.on('upgrade', (_req, sock) => {
      sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
      sock.on('data', d => sock.write('echo:' + String(d)))
    })
    await new Promise<void>(r => upstream!.listen(0, '127.0.0.1', r))
    const port = (upstream.address() as AddressInfo).port

    const { a } = build({ portFor: () => port })
    app = a
    await a.listen({ port: 0, host: '127.0.0.1' })
    const proxyPort = (a.server.address() as AddressInfo).port

    const out = await new Promise<string>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: proxyPort, path: '/preview/s1/hmr', headers: { Connection: 'Upgrade', Upgrade: 'websocket' } })
      req.on('upgrade', (_res, sock) => {
        sock.write('ping')
        sock.once('data', d => { resolve(String(d)); sock.destroy() })
      })
      req.on('error', reject)
      req.end()
    })
    expect(out).toBe('echo:ping')
  })

  it('destroys the client socket for an upgrade to a session with NO ready port', async () => {
    const { a } = build({ portFor: () => undefined })
    app = a
    await a.listen({ port: 0, host: '127.0.0.1' })
    const proxyPort = (a.server.address() as AddressInfo).port
    const closed = await new Promise<boolean>(resolve => {
      const req = http.request({ host: '127.0.0.1', port: proxyPort, path: '/preview/nope/hmr', headers: { Connection: 'Upgrade', Upgrade: 'websocket' } })
      req.on('error', () => resolve(true))   // socket destroyed → request errors
      req.on('upgrade', () => resolve(false)) // should NOT upgrade
      req.on('response', () => resolve(true)) // or a non-upgrade close
      req.end()
    })
    expect(closed).toBe(true)
  })
  // PR #83 review (HIGH): registering an 'upgrade' listener disables Node's default destroy of
  // UNHANDLED upgrade sockets — so a non-/preview upgrade MUST be destroyed, not left dangling
  // (else an unauthenticated client leaks FDs/sockets on the new surface). Without the fix this
  // promise never settles and the test times out.
  it('destroys the client socket for an upgrade to a NON-/preview path (no FD leak)', async () => {
    const { a } = build({ portFor: () => 1 })
    app = a
    await a.listen({ port: 0, host: '127.0.0.1' })
    const proxyPort = (a.server.address() as AddressInfo).port
    const closed = await new Promise<boolean>(resolve => {
      const req = http.request({ host: '127.0.0.1', port: proxyPort, path: '/notpreview/socket', headers: { Connection: 'Upgrade', Upgrade: 'websocket' } })
      req.on('error', () => resolve(true))
      req.on('upgrade', () => resolve(false))
      req.on('response', () => resolve(true))
      req.end()
    })
    expect(closed).toBe(true)
  })
})

describe('rewriteLocation (pure)', () => {
  it('rewrites a matching loopback redirect to the same-origin prefix', () => {
    expect(rewriteLocation('http://127.0.0.1:5190/foo/bar', 's1', 5190)).toBe('/preview/s1/foo/bar')
    expect(rewriteLocation('http://127.0.0.1:5190', 's1', 5190)).toBe('/preview/s1/')
  })
  it('leaves relative, foreign, and wrong-port locations untouched', () => {
    expect(rewriteLocation('/already/relative', 's1', 5190)).toBe('/already/relative')
    expect(rewriteLocation('https://example.com/x', 's1', 5190)).toBe('https://example.com/x')
    expect(rewriteLocation('http://127.0.0.1:9999/x', 's1', 5190)).toBe('http://127.0.0.1:9999/x')
    expect(rewriteLocation(undefined, 's1', 5190)).toBeUndefined()
  })
})
