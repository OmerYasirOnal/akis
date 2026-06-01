import { describe, it, expect } from 'vitest'
import { NullKnowledgePort, type KnowledgePort } from '../../src/knowledge/KnowledgePort.js'
import { assembleSharedContext } from '../../src/context/assemble.js'
import { MockSessionStore } from '../../src/store/MockSessionStore.js'
import { EventBus } from '../../src/events/bus.js'
import { initialSession, type KnowledgeChunk } from '@akis/shared'

describe('NullKnowledgePort', () => {
  it('grounds nothing until the RAG layer lands', async () => {
    expect(await new NullKnowledgePort().retrieve({ query: 'x', sessionId: 's1' })).toEqual([])
  })
})

describe('assembleSharedContext (F2-AC16 / F2-AC17)', () => {
  async function setup() {
    const store = new MockSessionStore()
    await store.create(initialSession('s1', 'todo app'))
    const bus = new EventBus()
    bus.emit({ kind: 'gate', gate: 'spec_approval', state: 'satisfied', agent: 'orchestrator', laneId: 'main', sessionId: 's1', ts: 1 })
    return { store, bus }
  }

  it('projects session + events + scratchpad + knowledge', async () => {
    const { store, bus } = await setup()
    const chunk: KnowledgeChunk = { id: 'k1', text: 'prior decision', source: 'sess/0', score: 0.9 }
    const knowledge: KnowledgePort = { async retrieve() { return [chunk] } }
    const ctx = await assembleSharedContext('s1', { store, bus, knowledge }, { query: 'todo app' })
    expect(ctx.session.id).toBe('s1')
    expect(ctx.events.length).toBe(1)
    expect(ctx.scratchpad.gates.specApproval).toBe('satisfied')
    expect(ctx.knowledge).toEqual([chunk])
  })

  it('passes the query (and session) to the knowledge port', async () => {
    const { store, bus } = await setup()
    let seen: { query: string; sessionId: string } | undefined
    const knowledge: KnowledgePort = { async retrieve(q) { seen = { query: q.query, sessionId: q.sessionId }; return [] } }
    await assembleSharedContext('s1', { store, bus, knowledge }, { query: 'find me' })
    expect(seen).toEqual({ query: 'find me', sessionId: 's1' })
  })

  it('throws "not found" for an unknown session', async () => {
    const { bus } = await setup()
    await expect(assembleSharedContext('nope', { store: new MockSessionStore(), bus, knowledge: new NullKnowledgePort() }, { query: 'x' }))
      .rejects.toThrow(/not found/)
  })

  it('does NOT freeze the store’s live session (M1: no hidden mutation of source of truth)', async () => {
    const store = new MockSessionStore()
    await store.create(initialSession('s1', 'idea'))
    // Give the session a nested object (spec) that the store holds.
    const created = (await store.get('s1'))!
    await store.update('s1', { spec: { title: 't', body: 'b' } }, created.version)
    const bus = new EventBus()

    await assembleSharedContext('s1', { store, bus, knowledge: new NullKnowledgePort() }, { query: 'x' })

    const live = (await store.get('s1'))!
    expect(Object.isFrozen(live.spec)).toBe(false) // store's live nested object untouched
    // ...and the store still accepts updates (a frozen spec would throw on patch in strict mode).
    await expect(store.update('s1', { status: 'building' }, live.version)).resolves.toBeDefined()
  })

  it('survives a circular reference in the event log (M2: no stack-overflow DoS)', async () => {
    const store = new MockSessionStore()
    await store.create(initialSession('s1', 'idea'))
    const bus = new EventBus()
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    bus.emit({ kind: 'tool_result', tool: 'dispatch_proto', ok: false, result: cyclic, agent: 'proto', laneId: 'main', sessionId: 's1', ts: 1 })
    await expect(assembleSharedContext('s1', { store, bus, knowledge: new NullKnowledgePort() }, { query: 'x' }))
      .resolves.toBeDefined()
  })

  it('degrades gracefully when knowledge.retrieve rejects (N2: grounding is best-effort)', async () => {
    const store = new MockSessionStore()
    await store.create(initialSession('s1', 'idea'))
    const bus = new EventBus()
    const flaky: KnowledgePort = { async retrieve() { throw new Error('RAG down') } }
    const ctx = await assembleSharedContext('s1', { store, bus, knowledge: flaky }, { query: 'x' })
    expect(ctx.knowledge).toEqual([]) // dispatch not failed by a retrieval outage
  })

  it('returns a deep-frozen, capability-free read view (F2-AC17)', async () => {
    const { store, bus } = await setup()
    const ctx = await assembleSharedContext('s1', { store, bus, knowledge: new NullKnowledgePort() }, { query: 'x' })
    // Frozen: a mutation attempt throws in strict mode (and never succeeds).
    expect(Object.isFrozen(ctx)).toBe(true)
    expect(Object.isFrozen(ctx.scratchpad)).toBe(true)
    expect(() => { (ctx as { session: unknown }).session = {} }).toThrow()
    // Capability-free: no function anywhere on the read view (no verifier/minter/store).
    const hasFn = (o: unknown): boolean =>
      !!o && typeof o === 'object' && Object.values(o).some(v => typeof v === 'function' || (typeof v === 'object' && hasFn(v)))
    expect(typeof (ctx as unknown as { retrieve?: unknown }).retrieve).toBe('undefined')
    expect(hasFn(ctx)).toBe(false)
  })
})
