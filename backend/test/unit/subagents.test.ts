import { describe, it, expect } from 'vitest'
import { MockGitHubAdapter } from '../../src/di/MockGitHubAdapter.js'
import { ScribeAgent } from '../../src/orchestrator/subagents/ScribeAgent.js'
import { ProtoAgent } from '../../src/orchestrator/subagents/ProtoAgent.js'
import { TraceAgent } from '../../src/orchestrator/subagents/TraceAgent.js'
import { MockProvider } from '../../src/agent/mock/MockProvider.js'
import { EventBus } from '../../src/events/bus.js'
import type { AkisEvent } from '@akis/shared'

describe('MockGitHubAdapter', () => {
  it('stores pushed files in memory keyed by session, readable back', async () => {
    const gh = new MockGitHubAdapter()
    const url = await gh.createRepo('s1')
    expect(url).toContain('mock')
    await gh.pushFiles('s1', [{ filePath: 'a.ts', content: 'x' }])
    expect(gh.read('s1')).toHaveLength(1)
  })
  it('createRepo is idempotent (does not wipe existing files)', async () => {
    const gh = new MockGitHubAdapter()
    await gh.createRepo('s1')
    await gh.pushFiles('s1', [{ filePath: 'a.ts', content: 'x' }])
    await gh.createRepo('s1')
    expect(gh.read('s1')).toHaveLength(1)
  })
})

describe('ScribeAgent', () => {
  it('produces a spec for a normal idea', async () => {
    const provider = new MockProvider({ script: [{ text: 'analysing' }] })
    const scribe = new ScribeAgent({ provider, bus: new EventBus() })
    const out = await scribe.run({ sessionId: 's1', laneId: 'main', idea: 'todo app' })
    expect(out.type).toBe('spec')
    if (out.type === 'spec') expect(out.spec.title).toContain('todo app')
  })
  it('asks for clarification when the knob is set', async () => {
    const provider = new MockProvider({ script: [{ text: 'need info' }], knobs: { mockNeedsClarification: true } })
    const scribe = new ScribeAgent({ provider, bus: new EventBus() })
    const out = await scribe.run({ sessionId: 's1', laneId: 'main', idea: 'thing' })
    expect(out.type).toBe('clarify')
  })
})

describe('ProtoAgent', () => {
  it('produces files and pushes them via the github adapter', async () => {
    const provider = new MockProvider({ script: [{ text: 'coding' }] })
    const gh = new MockGitHubAdapter(); await gh.createRepo('s1')
    const proto = new ProtoAgent({ provider, bus: new EventBus(), github: gh })
    const out = await proto.run({ sessionId: 's1', laneId: 'main', spec: { title: 't', body: 'b' } })
    expect(out.files.length).toBeGreaterThan(0)
    expect(gh.read('s1').length).toBeGreaterThan(0)
  })
})

describe('TraceAgent (verifier)', () => {
  it('emits a verify event with testsRun from the knob', async () => {
    const bus = new EventBus()
    const seen: AkisEvent[] = []
    bus.subscribe('s1', e => seen.push(e))
    const provider = new MockProvider({ script: [{ text: 'tests generated' }], knobs: { mockTraceTestCount: 2 } })
    const trace = new TraceAgent({ provider, bus })
    const out = await trace.run({ sessionId: 's1', laneId: 'main', files: [{ filePath: 'a.ts', content: 'x' }] })
    expect(out.testsRun).toBe(2)
    const v = seen.find(e => e.kind === 'verify')
    expect(v && v.kind === 'verify' && v.testsRun).toBe(2)
    expect(v && v.kind === 'verify' && v.agent).toBe('trace')
  })
  it('reports 0 tests when the knob says so (vacuous-green case)', async () => {
    const provider = new MockProvider({ script: [{ text: 'no tests' }], knobs: { mockTraceTestCount: 0 } })
    const trace = new TraceAgent({ provider, bus: new EventBus() })
    const out = await trace.run({ sessionId: 's1', laneId: 'main', files: [] })
    expect(out.testsRun).toBe(0)
    expect(out.passed).toBe(false)
  })
})
