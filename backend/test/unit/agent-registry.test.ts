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
})
