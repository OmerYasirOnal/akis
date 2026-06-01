import type { LlmProvider, ChatRequest, ChatResult } from '../LlmProvider.js'

export interface MockKnobs {
  mockNeedsClarification?: boolean
  mockCriticScore?: number      // < threshold (default 75) → block/iterate
  mockTraceTestCount?: number   // 0 → vacuous-green guard fires
  mockProtoFixesOnIterate?: boolean
}

export interface MockTurn { text?: string; toolCalls?: ChatResult['toolCalls'] }
export interface MockConfig { script: MockTurn[]; knobs?: MockKnobs }

export class MockProvider implements LlmProvider {
  readonly name = 'mock'
  readonly knobs: MockKnobs
  private i = 0
  constructor(private cfg: MockConfig) { this.knobs = cfg.knobs ?? {} }

  async chat(_req: ChatRequest): Promise<ChatResult> {
    const turn = this.cfg.script[this.i++]
    if (!turn) return { text: '' }
    const result: ChatResult = {}
    if (turn.text !== undefined) result.text = turn.text
    if (turn.toolCalls !== undefined) result.toolCalls = turn.toolCalls
    return result
  }
}
