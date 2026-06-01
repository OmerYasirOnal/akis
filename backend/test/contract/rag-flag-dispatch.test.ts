import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { buildServices } from '../../src/di/services.js'
import { Orchestrator } from '../../src/orchestrator/Orchestrator.js'
import { MockSessionStore } from '../../src/store/MockSessionStore.js'
import { MockProvider } from '../../src/agent/providers/mock/MockProvider.js'
import { createMockTestRunner } from '../../src/verify/TestRunner.js'
import { EventBus } from '../../src/events/bus.js'
import { buildRag } from '../../src/knowledge/buildRag.js'
import { assembleSharedContext } from '../../src/context/assemble.js'
import { NullKnowledgePort } from '../../src/knowledge/KnowledgePort.js'

const skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/skills/library')

describe('RAG feature flag (F1-AC11) + zero-touch ingestion (F1-AC1/AC17)', () => {
  it('flag OFF (default): NullKnowledgePort, no ingestion sink — behavior identical to no-RAG', async () => {
    const services = buildServices({ store: new MockSessionStore(), skillsDir, provider: new MockProvider() })
    expect(services.knowledge).toBeInstanceOf(NullKnowledgePort)
    expect(services.ingestionSink).toBeUndefined()
    expect(await services.knowledge.retrieve({ query: 'x', sessionId: 's1' })).toEqual([])
  })

  it('flag ON: knowledge is the RAG port and an ingestion sink is wired', () => {
    const services = buildServices({ store: new MockSessionStore(), skillsDir, provider: new MockProvider(), rag: true })
    expect(services.knowledge).not.toBeInstanceOf(NullKnowledgePort)
    expect(services.ingestionSink).toBeDefined()
  })

  it('end-to-end: starting a session ingests its narration zero-touch and it becomes retrievable', async () => {
    const bus = new EventBus()
    const rag = buildRag({ bus, queue: { backoffMs: () => 0 }, now: () => '2026-06-01T00:00:00Z' })
    const services = buildServices({
      store: new MockSessionStore(), skillsDir, bus,
      provider: new MockProvider(), testRunner: createMockTestRunner({ testsRun: 2, passed: true }),
      knowledge: rag.port, ingestionSink: rag.sink,
    })
    const orch = new Orchestrator(services)
    const s = await orch.start({ idea: 'todo planner app' }) // emits 'Planning: todo planner app' etc.
    await rag.queue.drain()

    // The session's own narration is now retrievable via the shared context's knowledge.
    const ctx = await assembleSharedContext(s.id, { store: services.store, bus, knowledge: services.knowledge }, { query: 'todo planner' })
    expect(ctx.knowledge.length).toBeGreaterThan(0)
    expect(ctx.knowledge.some(c => c.text.toLowerCase().includes('todo planner'))).toBe(true)
  })

  it('does not leak bus listeners: the ingestion sink unsubscribes when a session completes (M4)', async () => {
    const bus = new EventBus()
    const rag = buildRag({ bus, queue: { backoffMs: () => 0 }, now: () => '2026-06-01T00:00:00Z' })
    const services = buildServices({
      store: new MockSessionStore(), skillsDir, bus,
      provider: new MockProvider(), testRunner: createMockTestRunner({ testsRun: 2, passed: true }),
      knowledge: rag.port, ingestionSink: rag.sink,
    })
    const orch = new Orchestrator(services)
    const s = await orch.start({ idea: 'leak check app' })
    expect(bus.listenerCount(s.id)).toBe(1) // sink subscribed at start
    await orch.approve(s.id)
    await orch.runToVerification(s.id)
    await orch.confirmPush(s.id) // emits 'done' -> sink self-unsubscribes
    expect(bus.listenerCount(s.id)).toBe(0) // no dead listener left behind
  })

  it('RagKnowledgePort is read-only (F1-AC9): no mint/approve/gate capability', () => {
    const rag = buildRag({ bus: new EventBus() })
    const keys = Object.getOwnPropertyNames(Object.getPrototypeOf(rag.port))
    expect(keys).toContain('retrieve')
    expect(keys.some(k => /mint|approve|verify|gate/i.test(k))).toBe(false)
  })
})
