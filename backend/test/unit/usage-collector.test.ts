import { describe, it, expect } from 'vitest'
import { EventBus } from '../../src/events/bus.js'
import { UsageCollector } from '../../src/usage/UsageCollector.js'
import { UsageStore, type UsageStorePort, type UsageRecord } from '../../src/usage/UsageStore.js'
import { ANON_OWNER } from '../../src/usage/quota.js'
import { Orchestrator } from '../../src/orchestrator/Orchestrator.js'
import { MockSessionStore } from '../../src/store/MockSessionStore.js'
import { buildServices } from '../../src/di/services.js'
import { createMockTestRunner } from '../../src/verify/TestRunner.js'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import type { AkisEvent } from '@akis/shared'

const skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/skills/library')

const started = (sessionId: string, ownerId?: string): AkisEvent => ({
  kind: 'session', status: 'started', agent: 'orchestrator', laneId: 'main', sessionId, ts: 1,
  ...(ownerId ? { ownerId } : {}),
})
const agentEnd = (sessionId: string, usage?: { inTokens: number; outTokens: number }): AkisEvent => ({
  kind: 'agent_end', role: 'proto', ok: true, agent: 'proto', laneId: 'main', sessionId, ts: 2,
  ...(usage ? { metrics: { usage } } : { metrics: {} }),
})
// Terminal `session` event — failed/cancelled use this shape. NOTE: a SUCCESSFUL build does NOT
// emit session/done; its completion signal is the separate `kind:'done'` event below.
const terminal = (sessionId: string): AkisEvent => ({
  kind: 'session', status: 'failed', agent: 'orchestrator', laneId: 'main', sessionId, ts: 3,
})
// The REAL successful-completion signal the orchestrator emits (Orchestrator.confirmPush): a
// separate `kind:'done'`, NOT a session/done — so the collector must prune on it too.
const done = (sessionId: string): AkisEvent => ({
  kind: 'done', verified: true, provider: 'mock', agent: 'orchestrator', laneId: 'main', sessionId, ts: 4,
})

describe('UsageCollector', () => {
  it('accumulates from synthetic bus events: session/started(ownerId)+agent_end(usage) → owner periodTokens', async () => {
    const bus = new EventBus()
    const store = new UsageStore()
    new UsageCollector(store).attach(bus)
    bus.emit(started('s1', 'ada'))
    bus.emit(agentEnd('s1', { inTokens: 100, outTokens: 40 }))
    bus.emit(agentEnd('s1', { inTokens: 10, outTokens: 5 }))
    // let the fire-and-forget store.add settle
    await Promise.resolve()
    expect((await store.get('ada')).periodTokens).toBe(155)
  })

  it('agent_end WITHOUT metrics.usage adds 0 (honest absent)', async () => {
    const bus = new EventBus()
    const store = new UsageStore()
    new UsageCollector(store).attach(bus)
    bus.emit(started('s1', 'ada'))
    bus.emit(agentEnd('s1')) // no usage
    await Promise.resolve()
    // Unknown owner record is 0 (no add fired) — the owner was never charged a fabricated count.
    expect((await store.get('ada')).usedTokens).toBe(0)
  })

  it('agent_end for an unmapped session (no owner) is skipped, never misattributed', async () => {
    const bus = new EventBus()
    const calls: { ownerId: string; tokens: number }[] = []
    const store: UsageStorePort = {
      async add(ownerId, tokens) { calls.push({ ownerId, tokens }) },
      async get(ownerId): Promise<UsageRecord> { return { ownerId, usedTokens: 0, periodTokens: 0, windowStart: '' } },
      async snapshotAll() { return [] },
    }
    new UsageCollector(store).attach(bus)
    // agent_end with NO prior session/started mapping → no owner → skipped.
    bus.emit(agentEnd('orphan', { inTokens: 50, outTokens: 50 }))
    await Promise.resolve()
    expect(calls).toHaveLength(0)
  })

  it('anonymous started (no ownerId) charges its build spend to the shared __anon__ ledger', async () => {
    // Multi-tenant safety: an anonymous build (the costliest anonymous path) must be metered to
    // __anon__ — exactly like the chat route — so it counts against the shared budget and can
    // trip the __anon__ 429. (Previously this spend was added to NO ledger.)
    const bus = new EventBus()
    const store = new UsageStore()
    new UsageCollector(store).attach(bus)
    bus.emit(started('s1')) // anonymous — no ownerId
    bus.emit(agentEnd('s1', { inTokens: 9, outTokens: 9 }))
    await Promise.resolve()
    expect((await store.get(ANON_OWNER)).periodTokens).toBe(18)
  })

  it('prunes the owner mapping on a terminal session (no late misattribution / no leak)', async () => {
    const bus = new EventBus()
    const calls: { ownerId: string; tokens: number }[] = []
    const store: UsageStorePort = {
      async add(ownerId, tokens) { calls.push({ ownerId, tokens }) },
      async get(ownerId): Promise<UsageRecord> { return { ownerId, usedTokens: 0, periodTokens: 0, windowStart: '' } },
      async snapshotAll() { return [] },
    }
    new UsageCollector(store).attach(bus)
    bus.emit(started('s1', 'ada'))
    bus.emit(terminal('s1')) // prune (failed/cancelled)
    bus.emit(agentEnd('s1', { inTokens: 5, outTokens: 5 })) // a late agent_end → no mapping → skipped
    await Promise.resolve()
    expect(calls).toHaveLength(0)
  })

  it('prunes the owner mapping on the SUCCESS signal (kind:done) — no leak on a successful build', async () => {
    // A successful build emits a separate `kind:'done'` (NOT session/done), so the collector must
    // prune on `done` too — else the owner map grows unbounded over the process lifetime.
    const bus = new EventBus()
    const calls: { ownerId: string; tokens: number }[] = []
    const store: UsageStorePort = {
      async add(ownerId, tokens) { calls.push({ ownerId, tokens }) },
      async get(ownerId): Promise<UsageRecord> { return { ownerId, usedTokens: 0, periodTokens: 0, windowStart: '' } },
      async snapshotAll() { return [] },
    }
    const collector = new UsageCollector(store)
    collector.attach(bus)
    bus.emit(started('s1', 'ada'))
    bus.emit(agentEnd('s1', { inTokens: 7, outTokens: 3 })) // real spend during the build
    bus.emit(done('s1')) // SUCCESS — prune the owner mapping
    // A late agent_end after the success signal has no mapping → skipped (no leak, no misattribution).
    bus.emit(agentEnd('s1', { inTokens: 5, outTokens: 5 }))
    await Promise.resolve()
    expect(calls).toEqual([{ ownerId: 'ada', tokens: 10 }]) // only the in-flight spend, not the late one
    // The map itself was pruned (observable via the spy: a fresh agent_end on the same id is skipped).
    expect(collector.size).toBe(0)
  })

  it('a throwing store never breaks bus.emit (isolation, like StatsCollector)', () => {
    const bus = new EventBus()
    const store: UsageStorePort = {
      async add() { throw new Error('store down') },
      async get(ownerId): Promise<UsageRecord> { return { ownerId, usedTokens: 0, periodTokens: 0, windowStart: '' } },
      async snapshotAll() { return [] },
    }
    new UsageCollector(store).attach(bus)
    bus.emit(started('s1', 'ada'))
    // The throwing add must not propagate out of emit (the tap is isolated AND the rejected
    // promise is swallowed by the collector — never an unhandled rejection nor a broken emit).
    expect(() => bus.emit(agentEnd('s1', { inTokens: 1, outTokens: 1 }))).not.toThrow()
  })
})

// A REAL build driven through the orchestrator to `done` (not synthetic events). This guards the
// gap the synthetic test masked: the producer emits `kind:'done'` (NOT session/done) on success,
// so without the `done` prune the owner map would leak on every successful build.
describe('UsageCollector — real orchestrator success path prunes the owner map', () => {
  it('start→approve→run→confirmPush reaches done and the collector pruned (size back to 0)', async () => {
    const store = new MockSessionStore()
    const services = buildServices({
      store, skillsDir,
      mockCriticScore: 90,
      testRunner: createMockTestRunner({ testsRun: 2, passed: true }),
    })
    const collector = new UsageCollector(new UsageStore())
    collector.attach(services.bus)

    const orch = new Orchestrator(services)
    const s = await orch.start({ idea: 'build a todo web app', ownerId: 'ada' })
    // Mid-build the run is mapped (the started event carried ownerId 'ada').
    expect(collector.size).toBe(1)
    await orch.approve(s.id)
    await orch.runToVerification(s.id)
    const done = await orch.confirmPush(s.id)
    expect(done.status).toBe('done')
    // The REAL success signal is `kind:'done'` — the orchestrator never emits session/done — so
    // the collector must have pruned via the `done` branch. No leak on a successful build.
    expect(collector.size).toBe(0)
    // And the producer truly did NOT emit a session/done (the shape the synthetic test assumed).
    const sessionEvents = services.bus.recent(s.id).filter(e => e.kind === 'session') as { status: string }[]
    expect(sessionEvents.some(e => e.status === 'done')).toBe(false)
    expect(sessionEvents.some(e => e.status === 'started')).toBe(true)
  })
})
