import { describe, it, expect } from 'vitest'
import { EventBus } from '../../src/events/bus.js'
import { UsageCollector } from '../../src/usage/UsageCollector.js'
import { UsageStore, type UsageStorePort, type UsageRecord } from '../../src/usage/UsageStore.js'
import type { AkisEvent } from '@akis/shared'

const started = (sessionId: string, ownerId?: string): AkisEvent => ({
  kind: 'session', status: 'started', agent: 'orchestrator', laneId: 'main', sessionId, ts: 1,
  ...(ownerId ? { ownerId } : {}),
})
const agentEnd = (sessionId: string, usage?: { inTokens: number; outTokens: number }): AkisEvent => ({
  kind: 'agent_end', role: 'proto', ok: true, agent: 'proto', laneId: 'main', sessionId, ts: 2,
  ...(usage ? { metrics: { usage } } : { metrics: {} }),
})
const terminal = (sessionId: string): AkisEvent => ({
  kind: 'session', status: 'done', agent: 'orchestrator', laneId: 'main', sessionId, ts: 3,
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

  it('anonymous started (no ownerId) does not attribute its agent_end usage', async () => {
    const bus = new EventBus()
    const calls: string[] = []
    const store: UsageStorePort = {
      async add(ownerId) { calls.push(ownerId) },
      async get(ownerId): Promise<UsageRecord> { return { ownerId, usedTokens: 0, periodTokens: 0, windowStart: '' } },
      async snapshotAll() { return [] },
    }
    new UsageCollector(store).attach(bus)
    bus.emit(started('s1')) // anonymous — no ownerId
    bus.emit(agentEnd('s1', { inTokens: 9, outTokens: 9 }))
    await Promise.resolve()
    expect(calls).toHaveLength(0)
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
    bus.emit(terminal('s1')) // prune
    bus.emit(agentEnd('s1', { inTokens: 5, outTokens: 5 })) // a late agent_end → no mapping → skipped
    await Promise.resolve()
    expect(calls).toHaveLength(0)
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
