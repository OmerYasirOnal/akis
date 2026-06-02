import type { LlmProvider, ChatRequest, ChatResult, ChatMessage, ToolCall } from '../LlmProvider.js'
import { postJson, type PostOpts } from './http.js'

interface OpenAiConfig {
  name: 'openai' | 'openrouter'
  apiKey: string
  model: string
  baseUrl: string
  extraHeaders?: Record<string, string>
  fetchFn?: typeof fetch
}

interface OpenAiToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
interface OpenAiResponse {
  choices: { message: { content?: string | null; tool_calls?: OpenAiToolCall[] }; finish_reason?: string }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s) } catch { return {} }
}

/**
 * OpenAI Chat Completions adapter — serves BOTH OpenAI and OpenRouter (they
 * differ only by baseUrl + extra headers + model IDs). Auth via `Authorization:
 * Bearer`. `system` is a prepended message. Tools use `{type:'function',function:
 * {name,description,parameters}}`. Response `tool_calls[].function.arguments` is a
 * STRING → parsed defensively (falls back to {}). `tool` messages need
 * `tool_call_id`.
 */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name: 'openai' | 'openrouter'
  readonly model: string

  constructor(private cfg: OpenAiConfig) {
    this.name = cfg.name
    this.model = cfg.model
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const messages: Record<string, unknown>[] = [{ role: 'system', content: req.system }]
    for (const m of req.messages) messages.push(this.mapMessage(m))

    const body: Record<string, unknown> = { model: req.model || this.model, messages } // `||`: empty per-agent model falls back, never sends ""
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens
    if (req.temperature !== undefined) body.temperature = req.temperature
    if (req.tools?.length) {
      body.tools = req.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } }))
    }

    const opts: PostOpts = {}
    if (this.cfg.fetchFn) opts.fetchFn = this.cfg.fetchFn
    const res = await postJson<OpenAiResponse>(
      `${this.cfg.baseUrl}/chat/completions`,
      body,
      { authorization: `Bearer ${this.cfg.apiKey}`, ...(this.cfg.extraHeaders ?? {}) },
      opts,
    )

    const msg = res.choices[0]?.message
    const text = msg?.content ?? undefined
    const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).map(tc => ({
      id: tc.id,
      name: tc.function.name,
      args: safeJson(tc.function.arguments),
    }))

    const result: ChatResult = {}
    if (text) result.text = text
    if (toolCalls.length) result.toolCalls = toolCalls
    if (res.usage) result.usage = { inTokens: res.usage.prompt_tokens ?? 0, outTokens: res.usage.completion_tokens ?? 0 }
    // Forward the raw finish_reason ('stop' | 'length' | 'tool_calls' | ...) as
    // stopReason — parity with the Anthropic adapter.
    const finishReason = res.choices[0]?.finish_reason
    if (finishReason) result.stopReason = finishReason
    return result
  }

  private mapMessage(m: ChatMessage): Record<string, unknown> {
    if (m.role === 'tool') {
      if (!m.toolCallId) throw new Error('OpenAI tool result requires toolCallId (tool_call_id)')
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
        })),
      }
    }
    return { role: m.role, content: m.content }
  }
}
