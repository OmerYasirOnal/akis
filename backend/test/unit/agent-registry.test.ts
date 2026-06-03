import { describe, it, expect } from 'vitest'
import { AgentRegistry } from '../../src/agent/dynamic/AgentRegistry.js'
import type { AdvisoryAgent, AdvisoryInput, AdvisoryNote } from '../../src/agent/dynamic/AdvisoryAgent.js'

function stub(role: string): AdvisoryAgent {
  return { role, async advise(_i: AdvisoryInput): Promise<AdvisoryNote> { return { role, phase: 'pre_scribe', text: 'ok' } } }
}

describe('AgentRegistry', () => {
  it('registers advisory agents and lists them in registration order', () => {
    const r = new AgentRegistry()
    r.register(stub('researcher'), ['retrieve_knowledge'])
    r.register(stub('stylist'), [])
    expect(r.size).toBe(2)
    expect(r.roles()).toEqual(['researcher', 'stylist'])
    expect([...r.capabilities('researcher')]).toEqual(['retrieve_knowledge'])
    expect(r.list().map(e => e.agent.role)).toEqual(['researcher', 'stylist'])
  })

  it('REJECTS a gate capability at registration (runtime re-check behind validation)', () => {
    const r = new AgentRegistry()
    expect(() => r.register(stub('rogue'), ['run_tests'])).toThrow(/gate capability/i)
    expect(() => r.register(stub('rogue2'), ['push_to_github'])).toThrow(/gate capability/i)
    expect(() => r.register(stub('rogue3'), ['dispatch_trace'])).toThrow(/gate capability/i)
    expect(r.size).toBe(0)
  })

  it('rejects a duplicate role', () => {
    const r = new AgentRegistry()
    r.register(stub('a'))
    expect(() => r.register(stub('a'))).toThrow(/already registered/i)
  })

  it('listForPhase returns phase-pinned agents PLUS undefined-phase agents (every edge), in order', () => {
    const r = new AgentRegistry()
    r.register(stub('omni'), [])                       // no phase ⇒ every edge
    r.register(stub('pre'), [], 'pre_scribe')          // pinned to pre_scribe only
    r.register(stub('post'), [], 'post_code_review')   // pinned to post_code_review only
    expect(r.listForPhase('pre_scribe').map(e => e.agent.role)).toEqual(['omni', 'pre'])
    expect(r.listForPhase('post_code_review').map(e => e.agent.role)).toEqual(['omni', 'post'])
    // list() still returns everyone (phase is only a dispatch filter, not a removal).
    expect(r.list().map(e => e.agent.role)).toEqual(['omni', 'pre', 'post'])
  })
})
