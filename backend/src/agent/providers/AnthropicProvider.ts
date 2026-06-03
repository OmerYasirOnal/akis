import type { LlmProvider, ChatRequest, ChatResult, ChatMessage, ToolCall } from '../LlmProvider.js'
import { postJson, type PostOpts } from './http.js'

interface AnthropicConfig {
  apiKey: string
  model: string
  baseUrl?: string
  maxTokens?: number
  fetchFn?: typeof fetch
}

interface AnthropicTextBlock { type: 'text'; text: string }
interface AnthropicToolUseBlock { type: 'tool_use'; id: string; name: string; input: unknown }
type AnthropicBlock = AnthropicTextBlock | AnthropicToolUseBlock | { type: string; [k: string]: unknown }

interface AnthropicResponse {
  content: AnthropicBlock[]
  stop_reason?: string
  usage?: { input_tokens?: number; output_tokens?: number }
}

const ANTHROPIC_VERSION = '2023-06-01'

/**
 * Anthropic Messages API adapter.
 * - Auth via `x-api-key` (NOT Bearer) + mandatory `anthropic-version` header.
 * - `system` is a top-level param; `max_tokens` is REQUIRED.
 * - Tools declare `input_schema`; tool calls return as `tool_use` blocks whose
 *   `input` is already an object. Tool results ride inside a user message as the
 *   FIRST `tool_result` block, immediately after the assistant `tool_use` turn.
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic'
  readonly model: string
  private baseUrl: string
  private maxTokens: number

  constructor(private cfg: AnthropicConfig) {
    this.model = cfg.model
    this.baseUrl = cfg.baseUrl ?? 'https://api.anthropic.com'
    this.maxTokens = cfg.maxTokens ?? 4096
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: req.model?.trim() || this.model, // trim + `||`: an empty/blank per-agent model ("(default)") falls back, never sends "" / "  "
      max_tokens: req.maxTokens ?? this.maxTokens,
      system: req.system,
      messages: req.messages.map(m => this.mapMessage(m)),
    }
    if (req.temperature !== undefined) body.temperature = req.temperature
    if (req.tools?.length) {
      body.tools = req.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.schema }))
    }

    const opts: PostOpts = {}
    if (this.cfg.fetchFn) opts.fetchFn = this.cfg.fetchFn
    const res = await postJson<AnthropicResponse>(
      `${this.baseUrl}/v1/messages`,
      body,
      { 'x-api-key': this.cfg.apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      opts,
    )

    const text = res.content.filter((b): b is AnthropicTextBlock => b.type === 'text').map(b => b.text).join('')
    const toolCalls: ToolCall[] = res.content
      .filter((b): b is AnthropicToolUseBlock => b.type === 'tool_use')
      .map(b => ({ id: b.id, name: b.name, args: b.input }))

    const result: ChatResult = {}
    if (text) result.text = text
    if (toolCalls.length) result.toolCalls = toolCalls
    if (res.usage) result.usage = { inTokens: res.usage.input_tokens ?? 0, outTokens: res.usage.output_tokens ?? 0 }
    if (res.stop_reason) result.stopReason = res.stop_reason
    return result
  }

  private mapMessage(m: ChatMessage): Record<string, unknown> {
    if (m.role === 'tool') {
      if (!m.toolCallId) throw new Error('Anthropic tool result requires toolCallId (tool_use_id)')
      return {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }],
      }
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const blocks: Record<string, unknown>[] = []
      if (m.content) blocks.push({ type: 'text', text: m.content })
      for (const tc of m.toolCalls) blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args })
      return { role: 'assistant', content: blocks }
    }
    return { role: m.role, content: m.content }
  }
}
