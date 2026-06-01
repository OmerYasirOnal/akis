import type { LlmProvider, ChatRequest, ChatResult } from '../../LlmProvider.js'

export interface MockConfig {
  /** A fixed reply (e.g. a critic JSON blob) for deterministic tests. */
  reply?: string
}

/**
 * Deterministic provider used as the fallback when no real key is configured (or
 * NODE_ENV=test) and as a scriptable backend in tests. No network.
 */
export class MockProvider implements LlmProvider {
  readonly name = 'mock'
  readonly model = 'mock'
  constructor(private cfg: MockConfig = {}) {}

  async chat(req: ChatRequest): Promise<ChatResult> {
    const last = req.messages[req.messages.length - 1]?.content ?? ''
    return { text: this.cfg.reply ?? `mock: ${last.slice(0, 40)}`, usage: { inTokens: 0, outTokens: 0 } }
  }
}
