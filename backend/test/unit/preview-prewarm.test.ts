import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventBus } from '../../src/events/bus.js'
import { wirePreviewPrewarm } from '../../src/api/preview.routes.js'
import { nextTs } from '../../src/events/clock.js'
import type { PreviewRegistry, PreviewEntry } from '../../src/preview/PreviewRegistry.js'
import type { SessionStore } from '../../src/store/SessionStore.js'

const FILES = [{ filePath: 'index.html', content: '<html>app</html>' }]

function fakes(opts?: { existing?: PreviewEntry; files?: typeof FILES | []; atCapacity?: boolean }) {
  const start = vi.fn(async (id: string, dir: string, type: string): Promise<PreviewEntry> => ({ sessionId: id, status: 'ready', dir, ...(type ? { type: type as NonNullable<PreviewEntry['type']> } : {}) }))
  const registry = {
    start,
    get: vi.fn(() => opts?.existing),
    // CAP: the prewarm consults capacity before warming up (default: room available).
    atCapacity: vi.fn(() => opts?.atCapacity ?? false),
  } as unknown as PreviewRegistry
  const store = {
    get: vi.fn(async () => ({ id: 's1', code: { files: opts?.files ?? FILES } })),
  } as unknown as SessionStore
  return { registry, store, start }
}

const done = (sessionId: string) => ({ kind: 'done' as const, verified: true, provider: 'mock', agent: 'orchestrator' as const, laneId: 'main', sessionId, ts: nextTs() })

const settle = (): Promise<void> => new Promise(r => setTimeout(r, 20))
/** Poll until the spy fires (the prewarm chain does REAL fs work — a fixed 20ms flaked on CI). */
const until = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const t0 = Date.now()
  while (!cond() && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 25))
}

describe('wirePreviewPrewarm (ship-time boot, task #50 perceived latency)', () => {
  // startPreviewForSession MATERIALIZES real files — isolate the workspace dir per test
  // (tests must never touch the real ~/.akis).
  let wsDir: string
  let prevEnv: string | undefined
  beforeEach(() => {
    wsDir = mkdtempSync(join(tmpdir(), 'akis-prewarm-'))
    prevEnv = process.env.AKIS_WORKSPACES_DIR
    process.env.AKIS_WORKSPACES_DIR = wsDir
  })
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.AKIS_WORKSPACES_DIR
    else process.env.AKIS_WORKSPACES_DIR = prevEnv
    rmSync(wsDir, { recursive: true, force: true })
  })

  it('the done event triggers a fire-and-forget preview start for the shipped session', async () => {
    const bus = new EventBus()
    const { registry, store, start } = fakes()
    wirePreviewPrewarm(bus, store, registry)
    bus.emit(done('s1'))
    await until(() => start.mock.calls.length > 0)
    expect(start).toHaveBeenCalledTimes(1)
    expect(start.mock.calls[0]?.[0]).toBe('s1')
    expect(start.mock.calls[0]?.[2]).toBe('static')
  })

  it('NON-done events never trigger a boot', async () => {
    const bus = new EventBus()
    const { registry, store, start } = fakes()
    wirePreviewPrewarm(bus, store, registry)
    bus.emit({ kind: 'agent_start', role: 'proto', agent: 'proto', laneId: 'main', sessionId: 's1', ts: nextTs() })
    await settle()
    expect(start).not.toHaveBeenCalled()
  })

  // A3.3 — a rebuild (change request) that completes while a preview is LIVE used to early-return,
  // so the old process/materialized dir kept serving the PREVIOUS build's bytes with NO new
  // preview_status frame. The `done` of a NEW build now RESTARTS a 'ready' preview (start() stops
  // the same session's entry first → the maxConcurrent slot is reused, never consumed twice).
  it("a 'ready' preview IS restarted on done — the rebuild's new bytes must be served (A3.3)", async () => {
    const bus = new EventBus()
    const { registry, store, start } = fakes({ existing: { sessionId: 's1', status: 'ready', dir: '/x' } })
    wirePreviewPrewarm(bus, store, registry)
    bus.emit(done('s1'))
    await until(() => start.mock.calls.length > 0)
    expect(start).toHaveBeenCalledTimes(1)
    expect(start.mock.calls[0]?.[0]).toBe('s1')
  })

  it("a 'starting' preview still SKIPS — a boot already in flight is not thrashed (A3.3)", async () => {
    const bus = new EventBus()
    const { registry, store, start } = fakes({ existing: { sessionId: 's1', status: 'starting', dir: '/x' } })
    wirePreviewPrewarm(bus, store, registry)
    bus.emit(done('s1'))
    await settle()
    expect(start).not.toHaveBeenCalled()
  })

  it('two rapid done events for the SAME ready session restart exactly ONCE (in-flight guard)', async () => {
    // startPreviewForSession awaits store.get + materialize BEFORE registry.start flips the entry
    // to 'starting' — without a synchronous guard, a second `done` in that window reads a
    // still-'ready' entry and fires a concurrent duplicate restart (review LOW, 2026-06-11).
    const bus = new EventBus()
    const { registry, store, start } = fakes({ existing: { sessionId: 's1', status: 'ready', dir: '/x' } })
    wirePreviewPrewarm(bus, store, registry)
    bus.emit(done('s1'))
    bus.emit(done('s1'))
    await until(() => start.mock.calls.length > 0)
    await settle()
    expect(start).toHaveBeenCalledTimes(1)
  })

  it("the 'ready' RESTART is not blocked by the capacity gate (the session already holds its slot)", async () => {
    const bus = new EventBus()
    const { registry, store, start } = fakes({ existing: { sessionId: 's1', status: 'ready', dir: '/x' }, atCapacity: true })
    wirePreviewPrewarm(bus, store, registry)
    bus.emit(done('s1'))
    await until(() => start.mock.calls.length > 0)
    expect(start).toHaveBeenCalledTimes(1) // start() stops s1 first → the slot is REUSED, not doubled
  })

  it('a session with no produced code is a silent no-op (and a throwing start cannot crash the tap)', async () => {
    const bus = new EventBus()
    const { registry, store, start } = fakes({ files: [] })
    wirePreviewPrewarm(bus, store, registry)
    bus.emit(done('s1'))
    await settle()
    expect(start).not.toHaveBeenCalled()
    // throwing start: must not unhandled-reject
    const { registry: r2, store: s2 } = fakes()
    ;(r2.start as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'))
    const bus2 = new EventBus()
    wirePreviewPrewarm(bus2, s2, r2)
    bus2.emit(done('s1'))
    await settle() // no unhandled rejection = pass
  })

  it('unsubscribe stops future prewarms', async () => {
    const bus = new EventBus()
    const { registry, store, start } = fakes()
    const off = wirePreviewPrewarm(bus, store, registry)
    off()
    bus.emit(done('s1'))
    await settle()
    expect(start).not.toHaveBeenCalled()
  })
})

describe('prewarm capacity gate (audit bigger-bet)', () => {
  it('SKIPS the warm-up at capacity — a prewarm never evicts a live preview nor OOMs the box', async () => {
    const { registry, store, start } = fakes({ atCapacity: true })
    const bus = new EventBus()
    wirePreviewPrewarm(bus, store, registry)
    bus.emit({ kind: 'done', sessionId: 's1', verified: true, provider: 'mock', agent: 'orchestrator', laneId: 'main', ts: 1 })
    await new Promise(r => setTimeout(r, 5))
    expect(start).not.toHaveBeenCalled()
  })
})
