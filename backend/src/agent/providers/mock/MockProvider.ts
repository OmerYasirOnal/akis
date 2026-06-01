import type { LlmProvider, ChatRequest, ChatResult } from '../../LlmProvider.js'

export interface MockConfig {
  /** A fixed reply (e.g. a critic JSON blob) for deterministic tests. */
  reply?: string
}

/** A valid, approved critic review — so the fallback degrades gracefully (no parse crash). */
function defaultCriticJson(isCode: boolean): string {
  return JSON.stringify({
    approved: true,
    overallScore: 80,
    summary: 'mock provider (no real key configured) — auto-approved review',
    findings: [],
    reviewType: isCode ? 'code_review' : 'spec_review',
    iteration: 1,
    hasCriticalFinding: false,
    maxSeverity: 'info',
  })
}

/**
 * Deterministic provider used as the fallback when no real key is configured (or
 * NODE_ENV=test) and as a scriptable backend in tests. No network.
 *
 * IMPORTANT: when no explicit `reply` is set and the request looks like a critic
 * review (the only production consumer), the default is VALID critic JSON — so a
 * keyless production fallback degrades gracefully instead of throwing a JSON
 * parse error on every session.
 */
export class MockProvider implements LlmProvider {
  readonly name = 'mock'
  readonly model = 'mock'
  constructor(private cfg: MockConfig = {}) {}

  async chat(req: ChatRequest): Promise<ChatResult> {
    if (this.cfg.reply !== undefined) {
      return { text: this.cfg.reply, usage: { inTokens: 0, outTokens: 0 } }
    }
    // The critic system prompt identifies the reviewer; return parseable JSON.
    const sys = req.system.toLowerCase()
    if (sys.includes('reviewer')) {
      return { text: defaultCriticJson(sys.includes('code reviewer')), usage: { inTokens: 0, outTokens: 0 } }
    }
    const last = req.messages[req.messages.length - 1]?.content ?? ''
    return { text: `mock: ${last.slice(0, 40)}`, usage: { inTokens: 0, outTokens: 0 } }
  }
}
