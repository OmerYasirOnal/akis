import { describe, it, expect } from 'vitest'
import { MockProvider } from '../../src/agent/providers/mock/MockProvider.js'

describe('MockProvider', () => {
  it('echoes a deterministic ChatResult; reports name=mock', async () => {
    const p = new MockProvider()
    expect(p.name).toBe('mock')
    const r = await p.chat({ system: 's', messages: [{ role: 'user', content: 'hello' }] })
    expect(typeof r.text).toBe('string')
    expect(r.text).toContain('hello')
  })
  it('can be scripted to return a fixed reply (critic JSON in tests)', async () => {
    const p = new MockProvider({ reply: '{"approved":true}' })
    const r = await p.chat({ system: 's', messages: [] })
    expect(r.text).toBe('{"approved":true}')
  })
})
