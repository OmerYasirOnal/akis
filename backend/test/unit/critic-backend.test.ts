import { describe, it, expect } from 'vitest'
import { makeGenerateText } from '../../src/agent/criticBackend.js'
import { MockProvider } from '../../src/agent/providers/mock/MockProvider.js'

describe('criticBackend', () => {
  it('adapts generateText(system,user) over provider.chat and returns text', async () => {
    const gen = makeGenerateText(new MockProvider({ reply: '{"approved":true,"overallScore":90}' }))
    const out = await gen('SYS', 'USER')
    expect(out).toContain('approved')
  })
})
