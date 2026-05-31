import { describe, it, expect } from 'vitest'
import { runAgentLoop } from '../../src/agent/AgentLoop.js'
import { MockProvider } from '../../src/agent/mock/MockProvider.js'
import { EventBus } from '../../src/events/bus.js'
import { initialSession } from '@akis/shared'
import type { AkisEvent } from '@akis/shared'

describe('runAgentLoop', () => {
  it('executes permitted tools and emits a tool_call+tool_result per call', async () => {
    const bus = new EventBus()
    const events: AkisEvent[] = []
    bus.subscribe('s1', e => events.push(e))
    const session = { ...initialSession('s1', 'idea'), approvedSpec: { title: 't', body: 'b' } }
    const provider = new MockProvider({ script: [
      { toolCalls: [{ name: 'dispatch_proto', args: {} }] },
      { text: 'finished' },
    ] })
    const calls: string[] = []
    await runAgentLoop({
      role: 'orchestrator', system: '', laneId: 'main', sessionId: 's1', session, provider, bus,
      tools: [{ name: 'dispatch_proto', description: '', schema: {} }],
      execute: async (name) => { calls.push(name); return { ok: true } },
    })
    expect(calls).toEqual(['dispatch_proto'])
    expect(events.filter(e => e.kind === 'tool_call')).toHaveLength(1)
    expect(events.filter(e => e.kind === 'tool_result')).toHaveLength(1)
  })

  it('denies a tool the role may not use and does not execute it', async () => {
    const bus = new EventBus()
    const events: AkisEvent[] = []
    bus.subscribe('s1', e => events.push(e))
    const session = initialSession('s1', 'idea')
    const provider = new MockProvider({ script: [
      { toolCalls: [{ name: 'run_tests', args: {} }] },
      { text: 'done' },
    ] })
    const calls: string[] = []
    await runAgentLoop({
      role: 'proto', system: '', laneId: 'main', sessionId: 's1', session, provider, bus,
      tools: [{ name: 'run_tests', description: '', schema: {} }],
      execute: async (name) => { calls.push(name); return { ok: true } },
    })
    expect(calls).toEqual([])
    expect(events.some(e => e.kind === 'tool_result' && e.ok === false)).toBe(true)
  })
})
