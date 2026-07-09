import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventBus } from '../../src/events/bus.js'
import { wirePreviewPrewarm, startPreviewForSession } from '../../src/api/preview.routes.js'
import { nextTs } from '../../src/events/clock.js'
import { digestFiles } from '../../src/verify/digest.js'
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

  // F1(a)+(b) — two concurrent starts for one session can NEVER interleave (a second caller
  // coalesces onto the in-flight one), but a `done` landing mid-start is NOT dropped: it sets a
  // pending-done flag and the in-flight start's .finally runs exactly ONE trailing restart. So two
  // rapid dones for a ready session = the initial restart + ONE coalesced trailing restart.
  it('two rapid done events for a ready session = initial restart + ONE coalesced trailing restart (F1 b)', async () => {
    const bus = new EventBus()
    const { registry, store, start } = fakes({ existing: { sessionId: 's1', status: 'ready', dir: '/x' } })
    wirePreviewPrewarm(bus, store, registry)
    bus.emit(done('s1'))
    bus.emit(done('s1')) // lands while the first restart is in flight → coalesced into ONE trailing restart
    await until(() => start.mock.calls.length >= 2)
    await settle()
    expect(start).toHaveBeenCalledTimes(2) // NOT dropped (the rebuild's new bytes must be served), NOT N
  })

  it('MANY rapid dones during a start coalesce to a SINGLE trailing restart, not N (F1 b)', async () => {
    const bus = new EventBus()
    const { registry, store, start } = fakes({ existing: { sessionId: 's1', status: 'ready', dir: '/x' } })
    wirePreviewPrewarm(bus, store, registry)
    bus.emit(done('s1'))
    for (let i = 0; i < 5; i++) bus.emit(done('s1')) // 5 more during the in-flight start
    await until(() => start.mock.calls.length >= 2)
    await settle()
    expect(start).toHaveBeenCalledTimes(2) // initial + exactly one trailing (coalesced), never 6
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

  // ── F1 — PER-SESSION START SERIALIZATION (review 3399732510/3399732519/3399732532/3399732533) ──

  // (a) Two concurrent EXPLICIT starts (POST route + FE auto-run, or two rapid Run clicks) for one
  //     session must resolve to ONE registry.start — the second coalesces onto the in-flight boot
  //     instead of racing (a second start() would tear down the first's materialized dir, etc.).
  it('F1(a): two concurrent startPreviewForSession calls for one session → exactly ONE registry.start', async () => {
    const { registry, store, start } = fakes()
    const [a, b] = await Promise.all([
      startPreviewForSession(store, registry, 's1'),
      startPreviewForSession(store, registry, 's1'),
    ])
    expect(start).toHaveBeenCalledTimes(1) // the second coalesced onto the first
    expect(a).toEqual(b)                   // both callers got the SAME entry (the coalesced result)
  })

  it('F1(a): concurrent starts for DIFFERENT sessions are independent (each boots once)', async () => {
    const { registry, store, start } = fakes()
    await Promise.all([
      startPreviewForSession(store, registry, 's1'),
      startPreviewForSession(store, registry, 's2'),
    ])
    expect(start).toHaveBeenCalledTimes(2)
    expect(start.mock.calls.map(c => c[0]).sort()).toEqual(['s1', 's2'])
  })

  // (c) The done-with-ready RESTART re-reads the entry INSIDE the serialized section. If the user
  //     pressed Stop (or it was evicted) in the async window so the entry is no longer 'ready', the
  //     restart is SKIPPED — a teardown must not be immediately undone by a queued restart.
  it("F1(c): a restart whose entry is no longer 'ready' at boot time is SKIPPED (user pressed Stop)", async () => {
    const bus = new EventBus()
    // registry.get returns 'ready' when the tap first reads (so a restart is queued), then 'stopped'
    // by the time the serialized section re-reads it — the Stop landed in the async window.
    let reads = 0
    const start = vi.fn(async (id: string, dir: string, type: string): Promise<PreviewEntry> => ({ sessionId: id, status: 'ready', dir, ...(type ? { type: type as NonNullable<PreviewEntry['type']> } : {}) }))
    const registry = {
      start,
      get: vi.fn(() => { reads++; return { sessionId: 's1', status: reads <= 1 ? 'ready' : 'stopped', dir: '/x' } as PreviewEntry }),
      atCapacity: vi.fn(() => false),
    } as unknown as PreviewRegistry
    const store = { get: vi.fn(async () => ({ id: 's1', code: { files: FILES } })) } as unknown as SessionStore
    wirePreviewPrewarm(bus, store, registry)
    bus.emit(done('s1'))
    await settle()
    expect(start).not.toHaveBeenCalled() // the entry was 'stopped' at boot time → restart skipped
    expect(reads).toBeGreaterThanOrEqual(2) // both the tap read AND the in-section re-read happened
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

  // ── review 3399732516 (MED) — IDENTICAL-BYTES restart skip (the A3.3 stale-bytes guarantee
  //    must NOT regress: a DIFFERING digest still restarts, an IDENTICAL one no-ops) ──

  it("a done for a 'ready' preview whose bytes are UNCHANGED is a NO-OP (no restart, no re-install)", async () => {
    const bus = new EventBus()
    const sameDigest = digestFiles([...FILES])
    // The running entry already carries the digest of the SAME files the store will hand back.
    const { registry, store, start } = fakes({ existing: { sessionId: 's1', status: 'ready', dir: '/x', digest: sameDigest } })
    wirePreviewPrewarm(bus, store, registry)
    bus.emit(done('s1'))
    await settle()
    expect(start).not.toHaveBeenCalled() // identical bytes → the live preview is left running
  })

  it("a done for a 'ready' preview whose bytes DIFFER still RESTARTS (A3.3 stale-bytes guarantee)", async () => {
    const bus = new EventBus()
    // The running entry carries an OLD digest; the store hands back NEW files → restart must fire.
    const { registry, store, start } = fakes({ existing: { sessionId: 's1', status: 'ready', dir: '/x', digest: 'OLD-DIGEST' } })
    wirePreviewPrewarm(bus, store, registry)
    bus.emit(done('s1'))
    await until(() => start.mock.calls.length > 0)
    expect(start).toHaveBeenCalledTimes(1) // bytes changed → the rebuild's new bytes get served
  })

  it("a 'ready' preview with NO recorded digest still restarts (back-compat: pre-digest entries)", async () => {
    const bus = new EventBus()
    // An entry minted before the digest existed has no `digest` — a done must conservatively restart.
    const { registry, store, start } = fakes({ existing: { sessionId: 's1', status: 'ready', dir: '/x' } })
    wirePreviewPrewarm(bus, store, registry)
    bus.emit(done('s1'))
    await until(() => start.mock.calls.length > 0)
    expect(start).toHaveBeenCalledTimes(1)
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
