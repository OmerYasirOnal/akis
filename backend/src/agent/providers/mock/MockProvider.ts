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

/** A valid Scribe spec JSON so the live agent path works deterministically under the mock. */
function defaultScribeJson(rawIdea: string): string {
  // The agent appends a RAG grounding block to the user content; the mock would
  // otherwise echo it into the title. Use only the original idea (a real LLM writes
  // a clean title regardless). Also cap length so the demo title stays tidy.
  const idea = (rawIdea.split('\n\nRELEVANT PRIOR KNOWLEDGE')[0] ?? rawIdea).trim().slice(0, 80) || 'app'
  return JSON.stringify({
    kind: 'spec',
    title: `Spec for: ${idea}`,
    body: [
      `# ${idea}`, '', '## Problem', idea, '',
      '## Acceptance criteria',
      '- Given the app is open, When the user performs the core action, Then the expected result is shown.',
      '', '## Out of scope', '- Authentication, deployment.',
    ].join('\n'),
  })
}

/** A valid Proto files JSON so the live agent path works deterministically under the mock. */
function defaultProtoJson(): string {
  return JSON.stringify({
    files: [{ filePath: 'index.ts', content: "export const app = (): string => 'ok'\n" }],
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
    // Role-appropriate parseable JSON so the LIVE agent path works under the mock.
    const sys = req.system.toLowerCase()
    const last = req.messages[req.messages.length - 1]?.content ?? ''
    if (sys.includes('reviewer')) {
      return { text: defaultCriticJson(sys.includes('code reviewer')), usage: { inTokens: 0, outTokens: 0 } }
    }
    if (sys.includes('scribe')) {
      // The idea is the last user message; keep it for the spec title.
      return { text: defaultScribeJson(last || 'app'), usage: { inTokens: 0, outTokens: 0 } }
    }
    if (sys.includes('proto')) {
      return { text: defaultProtoJson(), usage: { inTokens: 0, outTokens: 0 } }
    }
    return { text: `mock: ${last.slice(0, 40)}`, usage: { inTokens: 0, outTokens: 0 } }
  }
}
