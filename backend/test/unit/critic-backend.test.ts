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

describe('buildServices providerName provenance', () => {
  it('reports the real provider name when a provider drives the critic (not hardcoded mock)', async () => {
    const { buildServices } = await import('../../src/di/services.js')
    const { MockSessionStore } = await import('../../src/store/MockSessionStore.js')
    const { fileURLToPath } = await import('node:url')
    const { dirname, resolve } = await import('node:path')
    const skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/skills/library')
    // A provider with a non-mock name, used because mockCriticScore is omitted.
    const provider = Object.assign(new MockProvider({ reply: '{}' }), { name: 'anthropic' as const })
    const services = buildServices({ store: new MockSessionStore(), skillsDir, provider })
    expect(services.providerName).toBe('anthropic')
  })
})
