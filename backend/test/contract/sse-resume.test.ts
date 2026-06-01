import { describe, it, expect, afterEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../../src/api/server.js'
import { buildServices } from '../../src/di/services.js'
import { Orchestrator } from '../../src/orchestrator/Orchestrator.js'
import { MockSessionStore } from '../../src/store/MockSessionStore.js'
import { MockProvider } from '../../src/agent/providers/mock/MockProvider.js'
import { createMockTestRunner } from '../../src/verify/TestRunner.js'
import { EventBus } from '../../src/events/bus.js'
import type { OrchestratorServices } from '../../src/di/services.js'
import type { KeyStore } from '../../src/keys/KeyStore.js'

const skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/skills/library')
const noKeyStore: KeyStore = { status: (p: string) => ({ provider: p, configured: false }), get: () => undefined, set: () => {}, remove: () => {}, list: () => [] }

let server: FastifyInstance | undefined
afterEach(async () => { await server?.close(); server = undefined })

async function listen(services: OrchestratorServices): Promise<string> {
  server = buildServer({ keyStore: noKeyStore, services, orchestrator: new Orchestrator(services) })
  await server.listen({ port: 0, host: '127.0.0.1' })
  const { port } = server.server.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

interface Frame { id?: number; event?: string; data?: string }
function parseFrame(raw: string): Frame {
  const f: Frame = {}
  for (const line of raw.split('\n')) {
    if (line.startsWith('id:')) f.id = Number(line.slice(3).trim())
    else if (line.startsWith('event:')) f.event = line.slice(6).trim()
    else if (line.startsWith('data:')) f.data = line.slice(5).trim()
  }
  return f
}

/** Connect to an SSE URL, collect frames until the stream goes idle, then abort. */
async function collectFrames(url: string, headers: Record<string, string> = {}, idleMs = 200, maxMs = 4000): Promise<Frame[]> {
  const ctrl = new AbortController()
  const res = await fetch(url, { headers, signal: ctrl.signal })
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const frames: Frame[] = []
  await new Promise<void>(done => {
    let idle: ReturnType<typeof setTimeout>
    const hard = setTimeout(finish, maxMs)
    function finish(): void { clearTimeout(idle); clearTimeout(hard); ctrl.abort(); done() }
    function bumpIdle(): void { clearTimeout(idle); idle = setTimeout(finish, idleMs) }
    bumpIdle()
    ;(async () => {
      try {
        for (;;) {
          const { value, done: d } = await reader.read()
          if (d) { finish(); break }
          buf += dec.decode(value, { stream: true })
          let i: number
          while ((i = buf.indexOf('\n\n')) >= 0) {
            frames.push(parseFrame(buf.slice(0, i)))
            buf = buf.slice(i + 2)
          }
          bumpIdle()
        }
      } catch { /* aborted — expected */ }
    })()
  })
  return frames
}

const dataFrames = (fs: Frame[]): Frame[] => fs.filter(f => f.id !== undefined)

function makeServices(opts: { bus?: EventBus } = {}): OrchestratorServices {
  return buildServices({
    store: new MockSessionStore(),
    skillsDir,
    provider: new MockProvider(),
    testRunner: createMockTestRunner({ testsRun: 2, passed: true }),
    ...(opts.bus ? { bus: opts.bus } : {}),
  })
}

describe('CONTRACT: resumable SSE (CF5 / F2-AC12)', () => {
  it('replays the full buffered stream on a fresh connect (no Last-Event-ID)', async () => {
    const services = makeServices()
    const base = await listen(services)
    const s = JSON.parse((await fetch(`${base}/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idea: 'todo' }) }).then(r => r.text())))
    const head = services.bus.head(s.id)
    expect(head).toBeGreaterThan(0)

    const frames = dataFrames(await collectFrames(`${base}/sessions/${s.id}/events`))
    const ids = frames.map(f => f.id)
    expect(ids).toEqual(Array.from({ length: head }, (_, i) => i + 1)) // contiguous 1..head, no gap/dup
  })

  it('resumes after reconnect with NO lost or duplicated steps (F2-AC12)', async () => {
    const services = makeServices()
    const base = await listen(services)
    const s = JSON.parse(await fetch(`${base}/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idea: 'todo' }) }).then(r => r.text()))

    // First connect: receive everything buffered so far, then drop.
    const first = dataFrames(await collectFrames(`${base}/sessions/${s.id}/events`))
    const lastSeen = Math.max(...first.map(f => f.id!))
    expect(lastSeen).toBe(services.bus.head(s.id))

    // While "disconnected", more steps happen.
    await fetch(`${base}/sessions/${s.id}/approve`, { method: 'POST' })
    const newHead = services.bus.head(s.id)
    expect(newHead).toBeGreaterThan(lastSeen)

    // Reconnect with Last-Event-ID = last seen: only NEW steps, contiguous, no dup.
    const second = dataFrames(await collectFrames(`${base}/sessions/${s.id}/events`, { 'Last-Event-ID': String(lastSeen) }))
    const ids2 = second.map(f => f.id!)
    expect(ids2).toEqual(Array.from({ length: newHead - lastSeen }, (_, i) => lastSeen + 1 + i))
    expect(Math.min(...ids2)).toBeGreaterThan(lastSeen) // no replay of already-seen (no dup)
  })

  it('survives an abrupt client disconnect and keeps emitting to other sessions (no wedge/crash)', async () => {
    const services = makeServices()
    const base = await listen(services)
    const a = JSON.parse(await fetch(`${base}/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idea: 'A' }) }).then(r => r.text()))

    // Open a stream, take one frame, then abruptly abort (client reset).
    const ctrl = new AbortController()
    const res = await fetch(`${base}/sessions/${a.id}/events`, { signal: ctrl.signal })
    const reader = res.body!.getReader()
    await reader.read()
    ctrl.abort()
    await reader.cancel().catch(() => {})

    // Emitting more on A (now a dead socket) must NOT throw into the bus/producer...
    const approve = await fetch(`${base}/sessions/${a.id}/approve`, { method: 'POST' })
    expect(approve.status).toBe(200)

    // ...and an independent session B must stream perfectly.
    const b = JSON.parse(await fetch(`${base}/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idea: 'B' }) }).then(r => r.text()))
    const bFrames = dataFrames(await collectFrames(`${base}/sessions/${b.id}/events`))
    expect(bFrames.map(f => f.id)).toEqual(Array.from({ length: services.bus.head(b.id) }, (_, i) => i + 1))
  })

  it('sends a reset control frame when the requested cursor was evicted (overflow)', async () => {
    const bus = new EventBus(3) // tiny cap to force eviction
    const services = makeServices({ bus })
    const base = await listen(services)
    const sid = 'overflow-1'
    // Seed a session in the store so the stream is not 404'd, then overflow the bus.
    await services.store.create({ ...(await import('@akis/shared')).initialSession(sid, 'x') })
    for (let i = 0; i < 6; i++) {
      services.bus.emit({ kind: 'text', text: `m${i}`, agent: 'orchestrator', laneId: 'main', sessionId: sid, ts: i })
    }
    // Client last saw seq 1, which has been evicted -> must be told to reset.
    const frames = await collectFrames(`${base}/sessions/${sid}/events`, { 'Last-Event-ID': '1' })
    expect(frames[0]?.event).toBe('reset')
  })
})
