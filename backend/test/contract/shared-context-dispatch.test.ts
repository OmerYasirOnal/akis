import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { buildServices } from '../../src/di/services.js'
import { Orchestrator } from '../../src/orchestrator/Orchestrator.js'
import { ScribeAgent } from '../../src/orchestrator/subagents/ScribeAgent.js'
import { ProtoAgent } from '../../src/orchestrator/subagents/ProtoAgent.js'
import { MockSessionStore } from '../../src/store/MockSessionStore.js'
import { MockProvider } from '../../src/agent/providers/mock/MockProvider.js'
import { createMockTestRunner } from '../../src/verify/TestRunner.js'
import { EventBus } from '../../src/events/bus.js'
import { mintApprovedSpec } from '../../src/gates/specGate.js'
import { approveSpec } from '../helpers/tokens.js'
import { initialSession, type SharedContext, type KnowledgeChunk } from '@akis/shared'
import type { KnowledgePort, RetrieveQuery } from '../../src/knowledge/KnowledgePort.js'

const skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/skills/library')

class SpyKnowledgePort implements KnowledgePort {
  calls: RetrieveQuery[] = []
  constructor(private chunks: KnowledgeChunk[] = []) {}
  async retrieve(q: RetrieveQuery): Promise<KnowledgeChunk[]> { this.calls.push(q); return this.chunks }
}

const ctxWith = (chunks: KnowledgeChunk[]): SharedContext => ({
  session: initialSession('s1', 'i'),
  events: [],
  scratchpad: { gates: {}, notes: [], errors: [] },
  knowledge: chunks,
})

describe('AKIS dispatches with a SharedContext read view (F2-AC16 / F2-AC17)', () => {
  it('the orchestrator retrieves knowledge for the session during a run', async () => {
    const knowledge = new SpyKnowledgePort()
    const services = buildServices({
      store: new MockSessionStore(), skillsDir,
      provider: new MockProvider(), testRunner: createMockTestRunner({ testsRun: 2, passed: true }),
      knowledge,
    })
    const orch = new Orchestrator(services)
    const s = await orch.start({ idea: 'todo app' })
    expect(knowledge.calls.length).toBeGreaterThan(0)
    expect(knowledge.calls[0]?.sessionId).toBe(s.id)
    expect(knowledge.calls[0]?.query).toContain('todo app')
  })

  it('Scribe grounds its prompt with the ctx knowledge slice', async () => {
    let userSeen = ''
    const provider = { name: 'fake', model: 'm', async chat(req: { messages: { content: string }[] }) { userSeen = req.messages[req.messages.length - 1]!.content; return { text: '{"kind":"spec","title":"t","body":"b"}' } } }
    const scribe = new ScribeAgent({ bus: new EventBus(), provider })
    await scribe.run({ sessionId: 's1', laneId: 'main', idea: 'todo', ctx: ctxWith([{ id: 'k1', text: 'use sqlite', source: 'sess/0', score: 0.8 }]) })
    expect(userSeen).toContain('use sqlite')
  })

  it('Proto grounds its prompt with the ctx knowledge slice', async () => {
    let userSeen = ''
    const provider = { name: 'fake', model: 'm', async chat(req: { messages: { content: string }[] }) { userSeen = req.messages[req.messages.length - 1]!.content; return { text: '{"files":[{"filePath":"a.ts","content":"x"}]}' } } }
    const spec = { title: 't', body: 'b' }
    const approved = mintApprovedSpec({ ...initialSession('s1', 'i'), spec, approval: approveSpec(spec) })
    const proto = new ProtoAgent({ bus: new EventBus(), provider })
    await proto.run({ sessionId: 's1', laneId: 'main', approved, ctx: ctxWith([{ id: 'k2', text: 'prefer fastify', source: 'repo/x', score: 0.7 }]) })
    expect(userSeen).toContain('prefer fastify')
  })

  it('agents still work with no ctx (back-compat)', async () => {
    const scribe = new ScribeAgent({ bus: new EventBus(), provider: new MockProvider() })
    const out = await scribe.run({ sessionId: 's1', laneId: 'main', idea: 'todo' })
    expect(out.type).toBe('spec')
  })
})
