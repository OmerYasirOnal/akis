import { describe, it, expect } from 'vitest'
import { MockGitHubAdapter } from '../../src/di/MockGitHubAdapter.js'
import { ScribeAgent, SCRIBE_SYSTEM } from '../../src/orchestrator/subagents/ScribeAgent.js'
import { ProtoAgent, PROTO_SYSTEM } from '../../src/orchestrator/subagents/ProtoAgent.js'
import { TraceAgent } from '../../src/orchestrator/subagents/TraceAgent.js'
import { resolveVerifier } from '../../src/verify/verifier.js'
import { mintApprovedSpec, SpecNotApprovedError } from '../../src/gates/specGate.js'
import { EventBus } from '../../src/events/bus.js'
import { initialSession } from '@akis/shared'
import type { AkisEvent, KnowledgeChunk } from '@akis/shared'
import { approveSpec } from '../helpers/tokens.js'
import { MockProvider } from '../../src/agent/providers/mock/MockProvider.js'
import type { KnowledgePort, RetrieveQuery } from '../../src/knowledge/KnowledgePort.js'
import type { LlmProvider, ChatRequest, ChatResult } from '../../src/agent/LlmProvider.js'

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

/** A KnowledgePort that returns one canned chunk and records every query it sees. */
function stubKnowledge(text: string): KnowledgePort & { queries: string[] } {
  const queries: string[] = []
  return {
    queries,
    async retrieve(q: RetrieveQuery): Promise<KnowledgeChunk[]> {
      queries.push(q.query)
      return [{ id: 'k1', text, source: 'session:s1', score: 0.91 }]
    },
  }
}

/** A provider scripted with a queue of results; records each request it receives,
 *  so the test can assert single-shot vs. tool-loop control flow byte-for-byte. */
function scriptedProvider(results: ChatResult[]): LlmProvider & { calls: ChatRequest[] } {
  const calls: ChatRequest[] = []
  let i = 0
  return {
    name: 'fake',
    model: 'fake',
    calls,
    async chat(req: ChatRequest): Promise<ChatResult> {
      calls.push(req)
      return results[i++] ?? { text: '{"kind":"spec","title":"Fallback","body":"# Fallback"}' }
    },
  }
}

describe('ScribeAgent — RAG-on tool loop (P3-AGENT-2)', () => {
  it('RAG ON: Scribe calls retrieve_knowledge, gets a result, and incorporates it; the tool_call/tool_result events are emitted', async () => {
    const knowledge = stubKnowledge('PRIOR: users want a dark mode toggle')
    // Turn 1: the model asks to ground itself. Turn 2: it answers with a spec that
    // weaves the retrieved grounding into the body.
    const provider = scriptedProvider([
      { toolCalls: [{ name: 'retrieve_knowledge', args: { query: 'prior context for todo app' }, id: 'c1' }] },
      { text: '{"kind":"spec","title":"Todo App","body":"# Todo App\\n\\nIncludes a dark mode toggle (per PRIOR knowledge)."}' },
    ])
    const bus = new EventBus()
    const seen: AkisEvent[] = []
    bus.subscribe('s1', e => seen.push(e))
    const scribe = new ScribeAgent({ bus, provider, knowledge, ragEnabled: true })
    const out = await scribe.run({ sessionId: 's1', laneId: 'main', idea: 'todo app' })

    // The tool actually ran (the port saw the model's query) and shaped the spec.
    expect(knowledge.queries).toEqual(['prior context for todo app'])
    expect(out.type).toBe('spec')
    if (out.type === 'spec') expect(out.spec.body).toContain('dark mode toggle')

    // The loop ran two provider round-trips (advertising the tool both times).
    expect(provider.calls).toHaveLength(2)
    expect(provider.calls[0]!.tools?.map(t => t.name)).toEqual(['retrieve_knowledge'])

    // CF2: the real tool_call/tool_result events for retrieve_knowledge are on the stream.
    expect(seen.some(e => e.kind === 'tool_call' && e.tool === 'retrieve_knowledge')).toBe(true)
    expect(seen.some(e => e.kind === 'tool_result' && e.tool === 'retrieve_knowledge')).toBe(true)
    // The frame still closes on the synthetic dispatch_scribe tool_result + agent_end.
    expect(seen.some(e => e.kind === 'tool_result' && e.tool === 'dispatch_scribe' && e.ok === true)).toBe(true)
    expect(seen.some(e => e.kind === 'agent_end' && e.agent === 'scribe' && e.ok === true)).toBe(true)
  })

  it('RAG OFF: Scribe is a single-shot dispatch with NO tool loop — byte-identical control flow', async () => {
    const knowledge = stubKnowledge('SHOULD NEVER BE QUERIED when RAG is off')
    const provider = scriptedProvider([{ text: '{"kind":"spec","title":"Todo","body":"# Todo"}' }])
    const bus = new EventBus()
    const seen: AkisEvent[] = []
    bus.subscribe('s1', e => seen.push(e))
    // ragEnabled omitted (default OFF) even though a knowledge port is injected.
    const scribe = new ScribeAgent({ bus, provider, knowledge })
    await scribe.run({ sessionId: 's1', laneId: 'main', idea: 'todo' })

    // EXACTLY one provider round-trip and the tool was never advertised nor called.
    expect(provider.calls).toHaveLength(1)
    expect(provider.calls[0]!.tools).toBeUndefined()
    expect(knowledge.queries).toEqual([])
    // No retrieve_knowledge events — the stream is identical to today's single-shot path.
    expect(seen.some(e => e.kind === 'tool_call' && e.tool === 'retrieve_knowledge')).toBe(false)
    expect(seen.some(e => e.kind === 'tool_call' && e.tool === 'dispatch_scribe')).toBe(true)
    expect(seen.some(e => e.kind === 'tool_result' && e.tool === 'dispatch_scribe')).toBe(true)
  })

  it('RAG OFF (no knowledge dep at all): unchanged from today', async () => {
    const provider = scriptedProvider([{ text: '{"kind":"spec","title":"X","body":"# X"}' }])
    const bus = new EventBus()
    const seen: AkisEvent[] = []
    bus.subscribe('s1', e => seen.push(e))
    const scribe = new ScribeAgent({ bus, provider })
    await scribe.run({ sessionId: 's1', laneId: 'main', idea: 'x' })
    expect(provider.calls).toHaveLength(1)
    expect(provider.calls[0]!.tools).toBeUndefined()
    expect(seen.some(e => e.kind === 'tool_call' && e.tool === 'dispatch_scribe')).toBe(true)
  })

  it('GUARD: Scribe\'s tool scope is ONLY retrieve_knowledge (no gate tool reachable)', async () => {
    const knowledge = stubKnowledge('grounding')
    const provider = scriptedProvider([
      { toolCalls: [{ name: 'retrieve_knowledge', args: { query: 'q' }, id: 'c1' }] },
      { text: '{"kind":"spec","title":"T","body":"# T"}' },
    ])
    const scribe = new ScribeAgent({ bus: new EventBus(), provider, knowledge, ragEnabled: true })
    await scribe.run({ sessionId: 's1', laneId: 'main', idea: 'idea' })
    // Every tool advertised to the provider, across every turn, is retrieve_knowledge —
    // never run_tests / push_to_github / verify / any approval/token-mint capability.
    const advertised = new Set(provider.calls.flatMap(c => (c.tools ?? []).map(t => t.name)))
    expect([...advertised]).toEqual(['retrieve_knowledge'])
    const gateTools = ['run_tests', 'push_to_github', 'verify', 'approve_spec', 'mint_verify_token', 'mint_approved_push']
    for (const g of gateTools) expect(advertised.has(g)).toBe(false)
  })

  it('GUARD: the bounded loop\'s turn cap is respected — a model that always calls a tool cannot loop forever', async () => {
    const knowledge = stubKnowledge('grounding')
    let chats = 0
    // A provider that NEVER stops asking for the tool — the bounded loop must cap it.
    const provider: LlmProvider = {
      name: 'fake', model: 'm',
      async chat(): Promise<ChatResult> {
        chats++
        return { toolCalls: [{ name: 'retrieve_knowledge', args: { query: 'again' }, id: `c${chats}` }] }
      },
    }
    const scribe = new ScribeAgent({ bus: new EventBus(), provider, knowledge, ragEnabled: true })
    const out = await scribe.run({ sessionId: 's1', laneId: 'main', idea: 'idea' })
    // The default tool-loop budget (4) is the hard cap — no infinite loop.
    expect(chats).toBeLessThanOrEqual(4)
    // Budget spent on a tool-only last turn ⇒ a degraded fallback spec, still typed.
    expect(out.type).toBe('spec')
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

describe('skill injection into the system prompt (P3-AGENT-1)', () => {
  const APPROVED = (() => {
    const spec = { title: 't', body: 'b' }
    const session = { ...initialSession('s1', 'i'), spec, approval: approveSpec(spec) }
    return mintApprovedSpec(session)
  })()

  it('Scribe: NO systemPrompt dep ⇒ the system sent is BYTE-IDENTICAL to SCRIBE_SYSTEM (parity)', async () => {
    const provider = scriptedProvider([{ text: '{"kind":"spec","title":"T","body":"# T"}' }])
    const scribe = new ScribeAgent({ bus: new EventBus(), provider })
    await scribe.run({ sessionId: 's1', laneId: 'main', idea: 'todo' })
    expect(provider.calls).toHaveLength(1)
    expect(provider.calls[0]!.system).toBe(SCRIBE_SYSTEM)
  })

  it('Scribe: an injected systemPrompt is the exact base sent (RAG OFF single-shot)', async () => {
    const composed = `${SCRIBE_SYSTEM}\n\n# Injected skills\n\n## Skill: web-app-spec (draft)\nSKILL BODY`
    const provider = scriptedProvider([{ text: '{"kind":"spec","title":"T","body":"# T"}' }])
    const scribe = new ScribeAgent({ bus: new EventBus(), provider, systemPrompt: composed })
    await scribe.run({ sessionId: 's1', laneId: 'main', idea: 'todo' })
    expect(provider.calls[0]!.system).toBe(composed)
    expect(provider.calls[0]!.system).toContain('SKILL BODY')
  })

  it('Scribe: the injected systemPrompt also flows into the RAG-ON tool-loop branch (+ the RAG hint)', async () => {
    const composed = `${SCRIBE_SYSTEM}\n\n# Injected skills\n\n## Skill: web-app-spec (draft)\nSKILL BODY`
    const knowledge = stubKnowledge('grounding')
    const provider = scriptedProvider([{ text: '{"kind":"spec","title":"T","body":"# T"}' }])
    const scribe = new ScribeAgent({ bus: new EventBus(), provider, knowledge, ragEnabled: true, systemPrompt: composed })
    await scribe.run({ sessionId: 's1', laneId: 'main', idea: 'todo' })
    // The RAG-on branch composes `${base}\n${RAG_HINT}` — the skill text MUST be present,
    // proving injection flows into BOTH compose() branches.
    expect(provider.calls[0]!.system).toContain('SKILL BODY')
    expect(provider.calls[0]!.system!.startsWith(composed)).toBe(true)
  })

  it('Proto: NO systemPrompt dep ⇒ the system sent is BYTE-IDENTICAL to PROTO_SYSTEM (parity)', async () => {
    const provider = scriptedProvider([{ text: '{"files":[{"filePath":"index.html","content":"<x>"}]}' }])
    const proto = new ProtoAgent({ bus: new EventBus(), provider })
    await proto.run({ sessionId: 's1', laneId: 'main', approved: APPROVED })
    expect(provider.calls).toHaveLength(1)
    expect(provider.calls[0]!.system).toBe(PROTO_SYSTEM)
  })

  it('Proto: an injected systemPrompt is the exact base sent', async () => {
    const composed = `${PROTO_SYSTEM}\n\n# Injected skills\n\n## Skill: react-spa-scaffold (draft)\nPROTO SKILL BODY`
    const provider = scriptedProvider([{ text: '{"files":[{"filePath":"index.html","content":"<x>"}]}' }])
    const proto = new ProtoAgent({ bus: new EventBus(), provider, systemPrompt: composed })
    await proto.run({ sessionId: 's1', laneId: 'main', approved: APPROVED })
    expect(provider.calls[0]!.system).toBe(composed)
    expect(provider.calls[0]!.system).toContain('PROTO SKILL BODY')
  })
})
