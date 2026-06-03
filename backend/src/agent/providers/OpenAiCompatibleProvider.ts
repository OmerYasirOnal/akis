import type { LlmProvider, ChatRequest, ChatResult, ChatMessage, ToolCall, OnDelta } from '../LlmProvider.js'
import { postJson, streamSse, type PostOpts } from './http.js'

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

/** A streaming chunk: each carries `choices[].delta.content` fragments + a finish_reason. */
interface OpenAiStreamChunk {
  choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[]
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

  /** Build the shared request body (identical for the stream + non-stream paths). */
  private buildBody(req: ChatRequest): Record<string, unknown> {
    const messages: Record<string, unknown>[] = [{ role: 'system', content: req.system }]
    for (const m of req.messages) messages.push(this.mapMessage(m))

    const body: Record<string, unknown> = { model: req.model?.trim() || this.model, messages } // trim+`||`: empty/blank model falls back, never sends "" / "  "
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens
    if (req.temperature !== undefined) body.temperature = req.temperature
    if (req.tools?.length) {
      body.tools = req.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } }))
    }
    return body
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.cfg.apiKey}`, ...(this.cfg.extraHeaders ?? {}) }
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const body = this.buildBody(req)

    const opts: PostOpts = {}
    if (this.cfg.fetchFn) opts.fetchFn = this.cfg.fetchFn
    const res = await postJson<OpenAiResponse>(
      `${this.cfg.baseUrl}/chat/completions`,
      body,
      this.headers(),
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

  /**
   * Streaming Chat Completions (`stream:true`): emit each `choices[0].delta.content`
   * fragment via `onDelta` and assemble the final text + finish_reason. Reuses the
   * SAME body builder as `chat` (system-prepended messages, model fallback, etc.), so
   * the persona/history/alternation are byte-identical. `[DONE]` is filtered upstream
   * by `streamSse`. Tool-call deltas aren't reassembled here — the persona chat is
   * text-only; the non-stream path keeps full tool support for the agents.
   */
  async chatStream(req: ChatRequest, onDelta: OnDelta): Promise<ChatResult> {
    const body = { ...this.buildBody(req), stream: true }
    const opts: PostOpts = {}
    if (this.cfg.fetchFn) opts.fetchFn = this.cfg.fetchFn

    let text = ''
    let stopReason: string | undefined
    await streamSse(`${this.cfg.baseUrl}/chat/completions`, body, this.headers(), data => {
      let chunk: OpenAiStreamChunk
      try { chunk = JSON.parse(data) as OpenAiStreamChunk } catch { return } // skip unparseable frames
      const choice = chunk.choices?.[0]
      const piece = choice?.delta?.content
      if (typeof piece === 'string' && piece) { text += piece; onDelta(piece) }
      if (choice?.finish_reason) stopReason = choice.finish_reason
    }, opts)

    const result: ChatResult = {}
    if (text) result.text = text
    if (stopReason) result.stopReason = stopReason
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
