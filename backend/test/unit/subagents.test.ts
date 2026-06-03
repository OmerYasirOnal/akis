import { describe, it, expect } from 'vitest'
import { MockGitHubAdapter } from '../../src/di/MockGitHubAdapter.js'
import { ScribeAgent } from '../../src/orchestrator/subagents/ScribeAgent.js'
import { ProtoAgent } from '../../src/orchestrator/subagents/ProtoAgent.js'
import { TraceAgent } from '../../src/orchestrator/subagents/TraceAgent.js'
import { resolveVerifier } from '../../src/verify/verifier.js'
import { mintApprovedSpec, SpecNotApprovedError } from '../../src/gates/specGate.js'
import { EventBus } from '../../src/events/bus.js'
import { initialSession } from '@akis/shared'
import type { AkisEvent } from '@akis/shared'
import { approveSpec } from '../helpers/tokens.js'
import { MockProvider } from '../../src/agent/providers/mock/MockProvider.js'

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
  it('produces a spec for a normal idea (live via provider)', async () => {
    const scribe = new ScribeAgent({ bus: new EventBus(), provider: new MockProvider() })
    const out = await scribe.run({ sessionId: 's1', laneId: 'main', idea: 'todo app' })
    expect(out.type).toBe('spec')
    if (out.type === 'spec') expect(out.spec.title).toContain('todo app')
  })
  it('asks for clarification when configured', async () => {
    const scribe = new ScribeAgent({ bus: new EventBus(), provider: new MockProvider(), needsClarification: true })
    const out = await scribe.run({ sessionId: 's1', laneId: 'main', idea: 'thing' })
    expect(out.type).toBe('clarify')
  })
  it('invokes the provider and emits tool_call + tool_result (CORE-AC1 / CF2)', async () => {
    let calls = 0
    const provider = { name: 'fake', model: 'm', async chat() { calls++; return { text: '{"kind":"spec","title":"Spec for: x","body":"# x"}' } } }
    const bus = new EventBus()
    const seen: AkisEvent[] = []
    bus.subscribe('s1', e => seen.push(e))
    const scribe = new ScribeAgent({ bus, provider })
    await scribe.run({ sessionId: 's1', laneId: 'main', idea: 'x' })
    expect(calls).toBe(1)
    expect(seen.some(e => e.kind === 'tool_call' && e.tool === 'dispatch_scribe')).toBe(true)
    expect(seen.some(e => e.kind === 'tool_result' && e.tool === 'dispatch_scribe')).toBe(true)
  })
  it('closes the event frame (tool_result ok:false + agent_end ok:false) when the provider throws', async () => {
    const provider = { name: 'fake', model: 'm', async chat(): Promise<{ text: string }> { throw new Error('auth failed') } }
    const bus = new EventBus()
    const seen: AkisEvent[] = []
    bus.subscribe('s1', e => seen.push(e))
    const scribe = new ScribeAgent({ bus, provider })
    await expect(scribe.run({ sessionId: 's1', laneId: 'main', idea: 'x' })).rejects.toThrow('auth failed')
    // No orphaned tool_call: the failed tool_result + agent_end close the frame.
    expect(seen.some(e => e.kind === 'tool_call' && e.tool === 'dispatch_scribe')).toBe(true)
    expect(seen.some(e => e.kind === 'tool_result' && e.tool === 'dispatch_scribe' && e.ok === false)).toBe(true)
    expect(seen.some(e => e.kind === 'agent_end' && e.agent === 'scribe' && e.ok === false)).toBe(true)
  })
  it('emits ok:false (honest) but still returns a fallback spec when the LLM output is unparseable', async () => {
    const provider = { name: 'fake', model: 'm', async chat(): Promise<{ text: string }> { return { text: 'not json at all' } } }
    const bus = new EventBus()
    const seen: AkisEvent[] = []
    bus.subscribe('s1', e => seen.push(e))
    const scribe = new ScribeAgent({ bus, provider })
    const out = await scribe.run({ sessionId: 's1', laneId: 'main', idea: 'thing' })
    expect(out.type).toBe('spec') // pipeline not blocked
    // ...but the degraded fallback must NOT be reported as a success.
    expect(seen.some(e => e.kind === 'tool_result' && e.tool === 'dispatch_scribe' && e.ok === false)).toBe(true)
    expect(seen.some(e => e.kind === 'agent_end' && e.agent === 'scribe' && e.ok === false)).toBe(true)
  })
})

describe('ProtoAgent', () => {
  it('requires an ApprovedSpec token and returns files (does not push)', async () => {
    const gh = new MockGitHubAdapter(); await gh.createRepo('s1')
    // ApprovedSpec can only come from mintApprovedSpec, which needs an ApprovalToken
    // minted by the approval authority and bound to the session's reviewed spec.
    const spec = { title: 't', body: 'b' }
    const session = { ...initialSession('s1', 'i'), spec, approval: approveSpec(spec) }
    const approved = mintApprovedSpec(session)
    const proto = new ProtoAgent({ bus: new EventBus(), provider: new MockProvider() })
    const out = await proto.run({ sessionId: 's1', laneId: 'main', approved })
    expect(out.files.length).toBeGreaterThan(0)
    expect(gh.read('s1')).toHaveLength(0) // Proto never pushes — push happens behind the gate
  })

  it('Gate 1: mintApprovedSpec throws without a valid approval token', () => {
    expect(() => mintApprovedSpec(initialSession('s1', 'i'))).toThrow(SpecNotApprovedError)
  })

  it('closes the event frame (tool_result ok:false + agent_end ok:false) when the provider throws', async () => {
    const spec = { title: 't', body: 'b' }
    const session = { ...initialSession('s1', 'i'), spec, approval: approveSpec(spec) }
    const approved = mintApprovedSpec(session)
    const provider = { name: 'fake', model: 'm', async chat(): Promise<{ text: string }> { throw new Error('rate limited') } }
    const bus = new EventBus()
    const seen: AkisEvent[] = []
    bus.subscribe('s1', e => seen.push(e))
    const proto = new ProtoAgent({ bus, provider })
    await expect(proto.run({ sessionId: 's1', laneId: 'main', approved })).rejects.toThrow('rate limited')
    expect(seen.some(e => e.kind === 'tool_call' && e.tool === 'dispatch_proto')).toBe(true)
    expect(seen.some(e => e.kind === 'tool_result' && e.tool === 'dispatch_proto' && e.ok === false)).toBe(true)
    expect(seen.some(e => e.kind === 'agent_end' && e.agent === 'proto' && e.ok === false)).toBe(true)
  })

  it('emits ok:false (honest) but still returns a placeholder file when the LLM output is unparseable', async () => {
    const spec = { title: 't', body: 'b' }
    const session = { ...initialSession('s1', 'i'), spec, approval: approveSpec(spec) }
    const approved = mintApprovedSpec(session)
    const provider = { name: 'fake', model: 'm', async chat(): Promise<{ text: string }> { return { text: 'garbage' } } }
    const bus = new EventBus()
    const seen: AkisEvent[] = []
    bus.subscribe('s1', e => seen.push(e))
    const proto = new ProtoAgent({ bus, provider })
    const out = await proto.run({ sessionId: 's1', laneId: 'main', approved })
    expect(out.files.length).toBeGreaterThan(0) // pipeline not blocked
    expect(seen.some(e => e.kind === 'tool_result' && e.tool === 'dispatch_proto' && e.ok === false)).toBe(true)
    expect(seen.some(e => e.kind === 'agent_end' && e.agent === 'proto' && e.ok === false)).toBe(true)
  })
})

describe('TraceAgent (verifier)', () => {
  it('returns a VerifyToken from a real passing run', async () => {
    const bus = new EventBus()
    const seen: AkisEvent[] = []
    bus.subscribe('s1', e => seen.push(e))
    const trace = new TraceAgent({ bus, verifier: resolveVerifier({ kind: 'mock', cfg: { testsRun: 2, passed: true } }) })
    const token = await trace.run({ sessionId: 's1', laneId: 'verify', files: [{ filePath: 'a.ts', content: 'x' }] })
    expect(token).not.toBeNull()
    expect(token?.testsRun).toBe(2)
    const v = seen.find(e => e.kind === 'verify')
    expect(v && v.kind === 'verify' && v.agent).toBe('trace')
    // CF2: the verifier's run_tests tool use is observable on the stream.
    expect(seen.some(e => e.kind === 'tool_call' && e.tool === 'run_tests')).toBe(true)
    expect(seen.some(e => e.kind === 'tool_result' && e.tool === 'run_tests' && e.ok === true)).toBe(true)
  })
  it('returns null for a 0-test run (no false green)', async () => {
    const trace = new TraceAgent({ bus: new EventBus(), verifier: resolveVerifier({ kind: 'mock', cfg: { testsRun: 0, passed: true } }) })
    const token = await trace.run({ sessionId: 's1', laneId: 'verify', files: [] })
    expect(token).toBeNull()
  })
  it('returns null when tests ran but failed', async () => {
    const trace = new TraceAgent({ bus: new EventBus(), verifier: resolveVerifier({ kind: 'mock', cfg: { testsRun: 3, passed: false } }) })
    const token = await trace.run({ sessionId: 's1', laneId: 'verify', files: [] })
    expect(token).toBeNull()
  })
})
