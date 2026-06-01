import { describe, it, expect } from 'vitest'
import { MockGitHubAdapter } from '../../src/di/MockGitHubAdapter.js'
import { ScribeAgent } from '../../src/orchestrator/subagents/ScribeAgent.js'
import { ProtoAgent } from '../../src/orchestrator/subagents/ProtoAgent.js'
import { TraceAgent } from '../../src/orchestrator/subagents/TraceAgent.js'
import { MockTestRunner } from '../../src/verify/TestRunner.js'
import { mintApprovedSpec } from '../../src/gates/specGate.js'
import { EventBus } from '../../src/events/bus.js'
import { initialSession } from '@akis/shared'
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
    const scribe = new ScribeAgent({ bus: new EventBus() })
    const out = await scribe.run({ sessionId: 's1', laneId: 'main', idea: 'todo app' })
    expect(out.type).toBe('spec')
    if (out.type === 'spec') expect(out.spec.title).toContain('todo app')
  })
  it('asks for clarification when configured', async () => {
    const scribe = new ScribeAgent({ bus: new EventBus(), needsClarification: true })
    const out = await scribe.run({ sessionId: 's1', laneId: 'main', idea: 'thing' })
    expect(out.type).toBe('clarify')
  })
})

describe('ProtoAgent', () => {
  it('requires an ApprovedSpec token and returns files (does not push)', async () => {
    const gh = new MockGitHubAdapter(); await gh.createRepo('s1')
    const approved = mintApprovedSpec({ ...initialSession('s1', 'i'), approvedSpec: { title: 't', body: 'b' } })
    const proto = new ProtoAgent({ bus: new EventBus() })
    const out = await proto.run({ sessionId: 's1', laneId: 'main', approved })
    expect(out.files.length).toBeGreaterThan(0)
    expect(gh.read('s1')).toHaveLength(0) // Proto never pushes — push happens behind the gate
  })
})

describe('TraceAgent (verifier)', () => {
  it('returns a VerifyToken from a real passing run', async () => {
    const bus = new EventBus()
    const seen: AkisEvent[] = []
    bus.subscribe('s1', e => seen.push(e))
    const trace = new TraceAgent({ bus, runner: new MockTestRunner({ testsRun: 2, passed: true }) })
    const token = await trace.run({ sessionId: 's1', laneId: 'verify', files: [{ filePath: 'a.ts', content: 'x' }] })
    expect(token).not.toBeNull()
    expect(token?.testsRun).toBe(2)
    const v = seen.find(e => e.kind === 'verify')
    expect(v && v.kind === 'verify' && v.agent).toBe('trace')
  })
  it('returns null for a 0-test run (no false green)', async () => {
    const trace = new TraceAgent({ bus: new EventBus(), runner: new MockTestRunner({ testsRun: 0, passed: true }) })
    const token = await trace.run({ sessionId: 's1', laneId: 'verify', files: [] })
    expect(token).toBeNull()
  })
  it('returns null when tests ran but failed', async () => {
    const trace = new TraceAgent({ bus: new EventBus(), runner: new MockTestRunner({ testsRun: 3, passed: false }) })
    const token = await trace.run({ sessionId: 's1', laneId: 'verify', files: [] })
    expect(token).toBeNull()
  })
})
