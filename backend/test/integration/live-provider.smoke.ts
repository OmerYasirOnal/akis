import { describe, it, expect } from 'vitest'
import { createProvider } from '../../src/agent/providers/createProvider.js'

/**
 * Guarded live smoke: each block runs a real one-shot chat ONLY if that
 * provider's key is in env AND we are not in the test fallback (NODE_ENV!=='test').
 * With no key (CI default), every block skips, so the suite stays green.
 *
 * Run a real check with, e.g.:
 *   ANTHROPIC_API_KEY=sk-ant-… NODE_ENV=production pnpm -C backend vitest run live-provider
 */
const live = (k: string) => !!process.env[k] && process.env.NODE_ENV !== 'test'
const env = process.env as Record<string, string | undefined>

describe.skipIf(!live('ANTHROPIC_API_KEY'))('live anthropic', () => {
  it('does a real one-shot chat', async () => {
    const p = createProvider({ provider: 'anthropic', env })
    const r = await p.chat({ system: 'Reply with the single word OK.', messages: [{ role: 'user', content: 'go' }], maxTokens: 16 })
    expect((r.text ?? '').length).toBeGreaterThan(0)
  }, 30_000)
})

describe.skipIf(!live('OPENAI_API_KEY'))('live openai', () => {
  it('does a real one-shot chat', async () => {
    const p = createProvider({ provider: 'openai', env })
    const r = await p.chat({ system: 'Reply with the single word OK.', messages: [{ role: 'user', content: 'go' }], maxTokens: 16 })
    expect((r.text ?? '').length).toBeGreaterThan(0)
  }, 30_000)
})

describe.skipIf(!live('OPENROUTER_API_KEY'))('live openrouter', () => {
  it('does a real one-shot chat', async () => {
    const p = createProvider({ provider: 'openrouter', env })
    const r = await p.chat({ system: 'Reply with the single word OK.', messages: [{ role: 'user', content: 'go' }], maxTokens: 16 })
    expect((r.text ?? '').length).toBeGreaterThan(0)
  }, 30_000)
})

describe.skipIf(!(live('GEMINI_API_KEY') || live('GOOGLE_API_KEY')))('live gemini', () => {
  it('does a real one-shot chat', async () => {
    const p = createProvider({ provider: 'google', env })
    const r = await p.chat({ system: 'Reply with the single word OK.', messages: [{ role: 'user', content: 'go' }], maxTokens: 16 })
    expect((r.text ?? '').length).toBeGreaterThan(0)
  }, 30_000)
})
