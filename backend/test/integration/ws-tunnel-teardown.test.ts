import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { createServer as createNetServer, connect, type Server as NetServer, type Socket } from 'node:net'
import type { AddressInfo } from 'node:net'
import { registerPreviewRoutes } from '../../src/api/preview.routes.js'
import type { PreviewRegistry } from '../../src/preview/PreviewRegistry.js'
import type { SessionStore } from '../../src/store/SessionStore.js'
import type { EventBus } from '../../src/events/bus.js'

/**
 * Teardown regressions for the WS upgrade tunnel (final review: the defensive destroy()
 * handlers in preview.routes.ts were untested). REAL sockets on both sides — the tunnel
 * lives below Fastify's route layer, so inject can't reach it at all.
 *
 * The fake upstream is a raw TCP server that answers the replayed upgrade with a 101 and
 * then echoes; we then kill one side and assert the OTHER side is reaped (no half-open
 * tunnel — the exact wedge the destroy handlers exist to prevent).
 */
describe('preview WS tunnel teardown', () => {
  let upstream: NetServer
  let upstreamPort: number
  let upstreamSockets: Socket[]
  let app: FastifyInstance
  let proxyPort: number
  let portForValue: (id: string) => number | undefined

  beforeAll(async () => {
    upstreamSockets = []
    upstream = createNetServer(sock => {
      upstreamSockets.push(sock)
      // Minimal ws-ish upstream: consume the replayed handshake, answer 101, then echo.
      sock.once('data', () => {
        sock.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: upgrade\r\n\r\n')
        sock.on('data', d => sock.write(d))
      })
    })
    await new Promise<void>(r => upstream.listen(0, '127.0.0.1', () => r()))
    upstreamPort = (upstream.address() as AddressInfo).port

    portForValue = () => upstreamPort
    app = Fastify({ logger: false })
    registerPreviewRoutes(app, {
      registry: { staticDirFor: () => undefined } as unknown as PreviewRegistry,
      store: { get: async () => undefined } as unknown as SessionStore,
      bus: { emit: () => {} } as unknown as EventBus,
      portFor: id => portForValue(id),
    })
    await app.listen({ port: 0, host: '127.0.0.1' })
    proxyPort = (app.server.address() as AddressInfo).port
  })
  afterAll(async () => {
    await app.close()
    await new Promise<void>(r => upstream.close(() => r()))
  })

  /** Open a raw client socket and send a WS upgrade request for /preview/:id/ws. */
  function openTunnel(id = 's1'): Promise<{ client: Socket; firstChunk: string }> {
    return new Promise((resolve, reject) => {
      const client = connect(proxyPort, '127.0.0.1', () => {
        client.write([
          `GET /preview/${id}/ws HTTP/1.1`,
          `host: 127.0.0.1:${proxyPort}`,
          'connection: Upgrade',
          'upgrade: websocket',
          'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==',
          'sec-websocket-version: 13',
          '', '',
        ].join('\r\n'))
      })
      client.once('data', d => resolve({ client, firstChunk: String(d) }))
      client.once('error', reject)
      setTimeout(() => reject(new Error('no upgrade reply within 5s')), 5000).unref()
    })
  }

  const settle = (): Promise<void> => new Promise(r => setTimeout(r, 150))

  it('tunnel works end to end (101 replayed; bytes echo both ways)', async () => {
    const { client, firstChunk } = await openTunnel()
    expect(firstChunk).toContain('101')
    const echoed = new Promise<string>(r => client.once('data', d => r(String(d))))
    client.write('ping-bytes')
    expect(await echoed).toBe('ping-bytes')
    client.destroy()
    await settle()
  })

  it('BROWSER side dying reaps the upstream socket (no half-open tunnel)', async () => {
    const before = upstreamSockets.length
    const { client } = await openTunnel()
    expect(upstreamSockets.length).toBe(before + 1)
    const upstreamSock = upstreamSockets[before]!
    const closed = new Promise<void>(r => upstreamSock.once('close', () => r()))
    client.destroy() // the browser vanishes mid-session
    await closed     // the tunnel MUST destroy its upstream leg
    expect(upstreamSock.destroyed).toBe(true)
  })

  it('UPSTREAM side dying reaps the browser socket', async () => {
    const before = upstreamSockets.length
    const { client } = await openTunnel()
    const upstreamSock = upstreamSockets[before]!
    const clientClosed = new Promise<void>(r => client.once('close', () => r()))
    upstreamSock.destroy() // the generated app's server dies mid-session
    await clientClosed     // the tunnel MUST destroy the browser leg too
    expect(client.destroyed).toBe(true)
  })

  it('an upgrade for a session with NO ready port is destroyed immediately (no FD leak)', async () => {
    portForValue = () => undefined
    try {
      const client = connect(proxyPort, '127.0.0.1', () => {
        client.write('GET /preview/ghost/ws HTTP/1.1\r\nhost: x\r\nconnection: Upgrade\r\nupgrade: websocket\r\n\r\n')
      })
      const closed = new Promise<void>(r => client.once('close', () => r()))
      await closed
      expect(client.destroyed).toBe(true)
    } finally {
      portForValue = () => upstreamPort
    }
  })
})
