/**
 * A3.2 + A3.4 — REPLAY-TIME PREVIEW LIVENESS PROJECTION.
 *
 * `preview_status` frames are persisted/replayed via the EventBus buffers, but the
 * PreviewRegistry (the actual processes) is in-memory only. After a backend restart —
 * or a ring-buffer eviction of the terminal frame — a replay could hand the FE a
 * 'ready' frame whose /preview/:id/ url is DEAD (iframe → 502, no Run affordance) or a
 * ghost 'starting' (a spinner with no boot behind it).
 *
 * The fix is a PROJECTION AT REPLAY TIME (never a mutation of the bus buffer, never a
 * hydrate-time rewrite — the registry doesn't even exist yet at hydrate): the LAST
 * replayed `preview_status` frame claiming liveness ('ready'/'starting') is rewritten
 * in the OUTGOING COPY to the registry's ground truth. Both replay doors are covered:
 * GET /sessions/:id/log and the SSE replay slice. Live-tapped frames are never touched
 * (they ARE ground truth). Verify-boot entries live under a '#verify'-suffixed registry
 * key, so the PLAIN session lookup can never read them as the session's liveness.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import Fastify, { type FastifyInstance } from 'fastify'
import { buildServer } from '../../src/api/server.js'
import { buildServices } from '../../src/di/services.js'
import { Orchestrator } from '../../src/orchestrator/Orchestrator.js'
import { MockSessionStore } from '../../src/store/MockSessionStore.js'
import { MockProvider } from '../../src/agent/providers/mock/MockProvider.js'
import { createMockTestRunner } from '../../src/verify/TestRunner.js'
import { registerSessionRoutes } from '../../src/api/sessions.routes.js'
import { projectPreviewLiveness, type PreviewLivenessEntry } from '../../src/preview/replayProjection.js'
import { nextTs } from '../../src/events/clock.js'
import type { SeqEvent } from '../../src/events/bus.js'
import type { AkisEvent } from '@akis/shared'
import type { KeyStore } from '../../src/keys/KeyStore.js'

const skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/skills/library')
const noKeyStore: KeyStore = { status: (p: string) => ({ provider: p, configured: false }), get: () => undefined, set: () => {}, remove: () => {}, list: () => [] }

const pv = (sessionId: string, status: 'starting' | 'ready' | 'failed' | 'stopped' | 'unsupported', extra: { url?: string; reason?: string; demo?: boolean } = {}): AkisEvent =>
  ({ kind: 'preview_status', status, ...extra, agent: 'orchestrator', laneId: 'main', sessionId, ts: nextTs() }) as AkisEvent

const seqd = (events: AkisEvent[]): SeqEvent[] => events.map((event, i) => ({ seq: i + 1, event }))

// ── The pure helper: events[] + registry lookup in, events[] out. ──
describe('projectPreviewLiveness (pure replay projection)', () => {
  it("rewrites a last-frame 'ready' the registry can't back to 'stopped' (url stripped)", () => {
    const events = seqd([pv('s1', 'starting'), pv('s1', 'ready', { url: '/preview/s1/' })])
    const out = projectPreviewLiveness(events, () => undefined)
    const last = out[out.length - 1]!.event
    expect(last).toMatchObject({ kind: 'preview_status', status: 'stopped' })
    expect((last as { url?: string }).url).toBeUndefined()
    expect(out[out.length - 1]!.seq).toBe(2) // the SEQ is preserved (transport cursor untouched)
    expect(out[0]!.event).toMatchObject({ status: 'starting' }) // earlier frames untouched
  })

  it("rewrites a ghost 'starting' (no registry entry) to 'stopped'", () => {
    const out = projectPreviewLiveness(seqd([pv('s1', 'starting')]), () => undefined)
    expect(out[0]!.event).toMatchObject({ kind: 'preview_status', status: 'stopped' })
  })

  it("a 'stopped' registry entry also projects 'stopped'", () => {
    const out = projectPreviewLiveness(seqd([pv('s1', 'ready', { url: '/preview/s1/' })]), () => ({ status: 'stopped' }))
    expect(out[0]!.event).toMatchObject({ status: 'stopped' })
  })

  it("passes a genuinely live replay through UNCHANGED (registry 'ready' — no false downgrade)", () => {
    const events = seqd([pv('s1', 'ready', { url: '/preview/s1/' })])
    const out = projectPreviewLiveness(events, () => ({ status: 'ready' }))
    expect(out[0]!.event).toMatchObject({ status: 'ready', url: '/preview/s1/' })
  })

  it("passes a 'starting' frame through while the registry is mid-boot ('starting')", () => {
    const events = seqd([pv('s1', 'starting')])
    const out = projectPreviewLiveness(events, () => ({ status: 'starting' }))
    expect(out[0]!.event).toMatchObject({ status: 'starting' })
  })

  it("projects a registry 'failed' entry as 'failed' WITH its reason (the FE Retry card)", () => {
    const out = projectPreviewLiveness(
      seqd([pv('s1', 'ready', { url: '/preview/s1/' })]),
      () => ({ status: 'failed', reason: 'preview crashed after start (code 1)' }),
    )
    expect(out[0]!.event).toMatchObject({ status: 'failed', reason: 'preview crashed after start (code 1)' })
    expect((out[0]!.event as { url?: string }).url).toBeUndefined()
  })

  it('leaves a last frame that already claims no liveness (stopped/failed) untouched', () => {
    const events = seqd([pv('s1', 'ready', { url: '/preview/s1/' }), pv('s1', 'stopped')])
    const out = projectPreviewLiveness(events, () => undefined)
    expect(out).toEqual(events)
  })

  // F4 — PreviewRegistry.stop() emits its 'stopped' frame as {...entry, status:'stopped'}, RETAINING
  // the prior 'ready' url; server.ts forwards it. A naturally-terminal last frame must NOT carry that
  // dead embeddable url (the contract: only a live ready may). The projection strips it within itself.
  it("strips the url off a naturally-terminal last 'stopped' frame that retained it (F4)", () => {
    const events = seqd([pv('s1', 'ready', { url: '/preview/s1/' }), pv('s1', 'stopped', { url: '/preview/s1/' })])
    const out = projectPreviewLiveness(events, () => undefined)
    const last = out[out.length - 1]!.event
    expect(last).toMatchObject({ kind: 'preview_status', status: 'stopped' })
    expect((last as { url?: string }).url).toBeUndefined()
    expect(out[out.length - 1]!.seq).toBe(2)            // seq preserved
    expect(out[0]!.event).toMatchObject({ status: 'ready', url: '/preview/s1/' }) // earlier frame intact
  })

  it("strips the url off a terminal 'failed' last frame too, keeping its reason (F4)", () => {
    const events = seqd([pv('s1', 'failed', { url: '/preview/s1/', reason: 'crashed' })])
    const out = projectPreviewLiveness(events, () => undefined)
    expect(out[0]!.event).toMatchObject({ status: 'failed', reason: 'crashed' })
    expect((out[0]!.event as { url?: string }).url).toBeUndefined()
  })

  it('a terminal last frame with NO url is left byte-identical (F4 no-op)', () => {
    const events = seqd([pv('s1', 'ready', { url: '/preview/s1/' }), pv('s1', 'stopped')])
    const out = projectPreviewLiveness(events, () => undefined)
    expect(out).toEqual(events)
    expect(out[out.length - 1]).toBe(events[events.length - 1]) // same object (no needless copy)
  })

  it('NEVER mutates the input frames (the bus buffer is shared) — only the outgoing copy changes', () => {
    const ready = pv('s1', 'ready', { url: '/preview/s1/' })
    const events = seqd([ready])
    projectPreviewLiveness(events, () => undefined)
    expect(ready).toMatchObject({ status: 'ready', url: '/preview/s1/' }) // original object intact
    expect(events[0]!.event).toBe(ready) // input slice still points at the original
  })

  it('looks the registry up by the PLAIN session id (a #verify entry can never back liveness)', () => {
    const lookups: string[] = []
    const entries = new Map<string, PreviewLivenessEntry>([['s1#verify-abc', { status: 'ready' }]])
    const out = projectPreviewLiveness(
      seqd([pv('s1', 'ready', { url: '/preview/s1/' })]),
      id => { lookups.push(id); return entries.get(id) },
    )
    expect(lookups).toEqual(['s1']) // plain key only
    expect(out[0]!.event).toMatchObject({ status: 'stopped' }) // the verify boot did NOT revive it
  })

  it('carries the demo flag across the projection (the badge stays honest on replay)', () => {
    const out = projectPreviewLiveness(seqd([pv('s1', 'ready', { url: '/preview/s1/', demo: true })]), () => undefined)
    expect(out[0]!.event).toMatchObject({ status: 'stopped', demo: true })
  })
})

// ── Route wiring: the projection guards BOTH replay doors. ──
function makeRouteApp(entry?: PreviewLivenessEntry | ((id: string) => PreviewLivenessEntry | undefined)) {
  const services = buildServices({
    store: new MockSessionStore(), skillsDir, provider: new MockProvider(),
    testRunner: createMockTestRunner({ testsRun: 2, passed: true }),
  })
  const lookups: string[] = []
  const get = typeof entry === 'function' ? entry : () => entry
  const app = Fastify({ logger: false })
  registerSessionRoutes(app, {
    orchestrator: new Orchestrator(services), services,
    previewRegistry: { get: (id: string) => { lookups.push(id); return get(id) } },
  })
  return { app, services, lookups }
}

const lastPreviewStatus = (events: SeqEvent[]): AkisEvent | undefined =>
  [...events].reverse().find(s => s.event.kind === 'preview_status')?.event

describe('CONTRACT: GET /sessions/:id/log projects a dead preview claim to registry ground truth', () => {
  it("a replayed last-frame 'ready' with NO registry entry comes back 'stopped' (url gone)", async () => {
    const { app, services } = makeRouteApp(undefined)
    const s = (await app.inject({ method: 'POST', url: '/sessions', payload: { idea: 'todo' } })).json()
    services.bus.emit(pv(s.id, 'starting'))
    services.bus.emit(pv(s.id, 'ready', { url: `/preview/${s.id}/` }))
    const res = await app.inject({ method: 'GET', url: `/sessions/${s.id}/log` })
    expect(res.statusCode).toBe(200)
    const last = lastPreviewStatus(res.json().events)
    expect(last).toMatchObject({ kind: 'preview_status', status: 'stopped' })
    expect((last as { url?: string }).url).toBeUndefined()
  })

  it("a replayed ghost 'starting' with NO registry entry comes back 'stopped' (no forever-spinner)", async () => {
    const { app, services } = makeRouteApp(undefined)
    const s = (await app.inject({ method: 'POST', url: '/sessions', payload: { idea: 'todo' } })).json()
    services.bus.emit(pv(s.id, 'starting'))
    const last = lastPreviewStatus((await app.inject({ method: 'GET', url: `/sessions/${s.id}/log` })).json().events)
    expect(last).toMatchObject({ status: 'stopped' })
  })

  it("a genuinely live preview (registry 'ready') replays UNCHANGED — no false downgrade", async () => {
    const { app, services } = makeRouteApp({ status: 'ready' })
    const s = (await app.inject({ method: 'POST', url: '/sessions', payload: { idea: 'todo' } })).json()
    services.bus.emit(pv(s.id, 'ready', { url: `/preview/${s.id}/` }))
    const last = lastPreviewStatus((await app.inject({ method: 'GET', url: `/sessions/${s.id}/log` })).json().events)
    expect(last).toMatchObject({ status: 'ready', url: `/preview/${s.id}/` })
  })

  it("a registry entry parked 'failed' replays as 'failed' with its reason (the localized Retry card)", async () => {
    const { app, services } = makeRouteApp({ status: 'failed', reason: 'install failed (code 1)' })
    const s = (await app.inject({ method: 'POST', url: '/sessions', payload: { idea: 'todo' } })).json()
    services.bus.emit(pv(s.id, 'ready', { url: `/preview/${s.id}/` }))
    const last = lastPreviewStatus((await app.inject({ method: 'GET', url: `/sessions/${s.id}/log` })).json().events)
    expect(last).toMatchObject({ status: 'failed', reason: 'install failed (code 1)' })
  })

  it('a #verify registry entry for the session does NOT make a dead frame look live', async () => {
    const { app, services, lookups } = makeRouteApp(id => (id.includes('#verify') ? { status: 'ready' } : undefined))
    const s = (await app.inject({ method: 'POST', url: '/sessions', payload: { idea: 'todo' } })).json()
    services.bus.emit(pv(s.id, 'ready', { url: `/preview/${s.id}/` }))
    const last = lastPreviewStatus((await app.inject({ method: 'GET', url: `/sessions/${s.id}/log` })).json().events)
    expect(last).toMatchObject({ status: 'stopped' })
    expect(lookups).toEqual([s.id]) // the PLAIN session key, never a suffixed one
  })
})

// ── SSE replay door (subscribe-before-replay ordering): the REPLAYED slice is projected. ──
let server: FastifyInstance | undefined
afterEach(async () => { await server?.close(); server = undefined })

interface Frame { id?: number; data?: string }
function parseFrames(raw: string): Frame[] {
  return raw.split('\n\n').filter(Boolean).map(block => {
    const f: Frame = {}
    for (const line of block.split('\n')) {
      if (line.startsWith('id:')) f.id = Number(line.slice(3).trim())
      else if (line.startsWith('data:')) f.data = line.slice(5).trim()
    }
    return f
  })
}

/** Collect SSE frames until idle, then abort (sse-resume.test.ts pattern, trimmed). */
async function collectSse(url: string, idleMs = 200, maxMs = 4000): Promise<Frame[]> {
  const ctrl = new AbortController()
  const res = await fetch(url, { signal: ctrl.signal })
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
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
          bumpIdle()
        }
      } catch { /* aborted — expected */ }
    })()
  })
  return parseFrames(buf)
}

describe('CONTRACT: the SSE replay slice projects a dead preview claim too', () => {
  async function listenWith(entry: PreviewLivenessEntry | undefined) {
    const { app, services } = makeRouteApp(entry)
    server = app
    await app.listen({ port: 0, host: '127.0.0.1' })
    const { port } = app.server.address() as AddressInfo
    return { base: `http://127.0.0.1:${port}`, services, app }
  }

  it("the replayed 'ready' frame arrives as 'stopped' when the registry can't back it", async () => {
    const { base, services, app } = await listenWith(undefined)
    const s = (await app.inject({ method: 'POST', url: '/sessions', payload: { idea: 'todo' } })).json()
    services.bus.emit(pv(s.id, 'ready', { url: `/preview/${s.id}/` }))
    const frames = await collectSse(`${base}/sessions/${s.id}/events`)
    const previews = frames
      .map(f => { try { return JSON.parse(f.data ?? '') as AkisEvent } catch { return undefined } })
      .filter((e): e is AkisEvent => !!e && e.kind === 'preview_status')
    expect(previews.length).toBeGreaterThan(0)
    expect(previews[previews.length - 1]).toMatchObject({ status: 'stopped' })
    expect((previews[previews.length - 1] as { url?: string }).url).toBeUndefined()
  })

  it("a genuinely live replay ('ready' backed by the registry) streams UNCHANGED", async () => {
    const { base, services, app } = await listenWith({ status: 'ready' })
    const s = (await app.inject({ method: 'POST', url: '/sessions', payload: { idea: 'todo' } })).json()
    services.bus.emit(pv(s.id, 'ready', { url: `/preview/${s.id}/` }))
    const frames = await collectSse(`${base}/sessions/${s.id}/events`)
    const previews = frames
      .map(f => { try { return JSON.parse(f.data ?? '') as AkisEvent } catch { return undefined } })
      .filter((e): e is AkisEvent => !!e && e.kind === 'preview_status')
    expect(previews[previews.length - 1]).toMatchObject({ status: 'ready', url: `/preview/${s.id}/` })
  })
})

// ── End-to-end wiring proof: buildServer passes ITS OWN registry into the session routes. ──
describe('CONTRACT: buildServer wires the live PreviewRegistry into the replay projection', () => {
  it('a replayed ready frame on a fresh (empty-registry) server comes back stopped from GET /log', async () => {
    const services = buildServices({
      store: new MockSessionStore(), skillsDir, provider: new MockProvider(),
      testRunner: createMockTestRunner({ testsRun: 2, passed: true }),
    })
    const app = buildServer({ keyStore: noKeyStore, services, orchestrator: new Orchestrator(services) })
    const s = (await app.inject({ method: 'POST', url: '/sessions', payload: { idea: 'todo' } })).json()
    // Simulate the post-restart replay: the buffered frame claims ready, the registry is EMPTY.
    services.bus.emit(pv(s.id, 'ready', { url: `/preview/${s.id}/` }))
    const last = lastPreviewStatus((await app.inject({ method: 'GET', url: `/sessions/${s.id}/log` })).json().events)
    expect(last).toMatchObject({ status: 'stopped' })
  })
})
