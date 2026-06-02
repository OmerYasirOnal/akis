import { describe, it, expect } from 'vitest'
import type { LlmProvider } from '../../src/agent/LlmProvider.js'

describe('LlmProvider seam', () => {
  it('a minimal provider satisfies the interface and returns a ChatResult', async () => {
    const p: LlmProvider = {
      name: 'fake',
      model: 'm',
      async chat(req) {
        return { text: `sys:${req.system.length}`, usage: { inTokens: 1, outTokens: 1 } }
      },
    }
    const r = await p.chat({ system: 'hi', messages: [{ role: 'user', content: 'x' }] })
    expect(r.text).toBe('sys:2')
    expect(r.usage).toEqual({ inTokens: 1, outTokens: 1 })
  })
})
