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
