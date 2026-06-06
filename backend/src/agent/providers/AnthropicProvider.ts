import type { LlmProvider, ChatRequest, ChatResult, ChatMessage, ToolCall, OnDelta } from '../LlmProvider.js'
import { postJson, streamSse, type PostOpts } from './http.js'

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
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
}

/** The subset of Anthropic streaming SSE events we consume (text + stop/usage). */
interface AnthropicStreamEvent {
  type: string
  delta?: { type?: string; text?: string; stop_reason?: string }
  message?: { usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }
  usage?: { output_tokens?: number }
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
/** The conversation-level cache breakpoint only helps once the prompt clears the model's
 *  cacheable minimum (4096 tokens on Haiku 4.5/Opus; sub-minimum markers are silently inert).
 *  4500 adds margin over the worst-case minimum; chars/4 is the standard rough estimate. */
export const CACHE_MIN_PROMPT_TOKENS = 4500
function estimatePromptTokens(req: ChatRequest): number {
  const chars = req.system.length + req.messages.reduce((n, m) => n + (m.content?.length ?? 0), 0)
  return Math.floor(chars / 4)
}

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic'
  readonly model: string
  private baseUrl: string
  private maxTokens: number

  constructor(private cfg: AnthropicConfig) {
    this.model = cfg.model
    this.baseUrl = cfg.baseUrl ?? 'https://api.anthropic.com'
    // 8192 (not 4096): the build agents (Proto writes WHOLE apps, Scribe/Critic) don't set a
    // per-request maxTokens, and 4096 TRUNCATED a non-trivial app mid-JSON → unparseable → the
    // agent failed. 8192 is the safe cross-model output ceiling (every modern Claude supports it).
    this.maxTokens = cfg.maxTokens ?? 8192
  }

  /** Build the shared request body (identical for the stream + non-stream paths). */
  private buildBody(req: ChatRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: req.model?.trim() || this.model, // trim + `||`: an empty/blank per-agent model ("(default)") falls back, never sends "" / "  "
      max_tokens: req.maxTokens ?? this.maxTokens,
      // PROMPT CACHING: the system prompt rides as a content block with a cache breakpoint.
      // Every agent (Scribe/Proto/Critic/AKIS chat) resends the same skill-composed system
      // prefix each call — with the breakpoint, repeats within the cache TTL read it at ~10%
      // input cost and lower latency (iterate loops, continuation rounds, chat turns). Tools
      // ahead of the breakpoint are cached too. Prompts under the model's cacheable minimum
      // are silently uncached (documented; never an error) — a pure optimization, responses
      // byte-identical either way.
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      messages: req.messages.map(m => this.mapMessage(m)),
    }
    // MULTI-TURN PROMPT CACHING (the audit's inert-caching fix): the per-agent system prompts are
    // 393-1087 tokens — far below the 4096-token cacheable minimum on Haiku 4.5/Opus — so the
    // system breakpoint alone NEVER cached anything (cache_creation stayed 0; now observable via
    // usage.cacheReadTokens). The real repeated prefix is the GROWING CONVERSATION: iterate /
    // continuation rounds resend spec+code+feedback within seconds, well inside the 5-minute TTL.
    // Marking the LAST message caches the whole rendered prefix (tools → system → messages); the
    // next round appends turns AFTER the marker and re-reads everything before it at ~0.1×
    // (write premium 1.25× — break-even at the 2nd round). Only marked when the estimated prompt
    // clears the minimum with margin: a sub-minimum marker is silently inert, and small one-shot
    // chats stay byte-identical to today.
    const msgs = body.messages as Record<string, unknown>[]
    if (msgs.length > 0 && estimatePromptTokens(req) >= CACHE_MIN_PROMPT_TOKENS) {
      const last = msgs[msgs.length - 1]!
      const content = last.content
      if (typeof content === 'string') {
        last.content = [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }]
      } else if (Array.isArray(content) && content.length > 0) {
        ;(content[content.length - 1] as Record<string, unknown>).cache_control = { type: 'ephemeral' }
      }
    }
    if (req.temperature !== undefined) body.temperature = req.temperature
    if (req.tools?.length) {
      body.tools = req.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.schema }))
    }
    return body
  }

  private headers(): Record<string, string> {
    return { 'x-api-key': this.cfg.apiKey, 'anthropic-version': ANTHROPIC_VERSION }
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const body = this.buildBody(req)

    const opts: PostOpts = {}
    if (this.cfg.fetchFn) opts.fetchFn = this.cfg.fetchFn
    const res = await postJson<AnthropicResponse>(
      `${this.baseUrl}/v1/messages`,
      body,
      this.headers(),
      opts,
    )

    const text = res.content.filter((b): b is AnthropicTextBlock => b.type === 'text').map(b => b.text).join('')
    const toolCalls: ToolCall[] = res.content
      .filter((b): b is AnthropicToolUseBlock => b.type === 'tool_use')
      .map(b => ({ id: b.id, name: b.name, args: b.input }))

    const result: ChatResult = {}
    if (text) result.text = text
    if (toolCalls.length) result.toolCalls = toolCalls
    if (res.usage) {
      // CACHE VISIBILITY (audit quick-win): surface cache_read/cache_creation so 'is prompt
      // caching firing at all?' is finally observable. Visibility ONLY — input_tokens is already
      // the uncached remainder, so these never enter quota math.
      result.usage = {
        inTokens: res.usage.input_tokens ?? 0,
        outTokens: res.usage.output_tokens ?? 0,
        ...(res.usage.cache_read_input_tokens ? { cacheReadTokens: res.usage.cache_read_input_tokens } : {}),
        ...(res.usage.cache_creation_input_tokens ? { cacheCreateTokens: res.usage.cache_creation_input_tokens } : {}),
      }
    }
    if (res.stop_reason) result.stopReason = res.stop_reason
    return result
  }

  /**
   * Streaming Messages API (`stream:true`): emit each `content_block_delta` text
   * fragment via `onDelta` and assemble the final text. Reuses the SAME body builder
   * as `chat` so the persona/history/alternation are byte-identical. Tool-use deltas
   * aren't surfaced here (the persona chat is text-only); the non-stream path keeps
   * full tool support for the agents.
   */
  async chatStream(req: ChatRequest, onDelta: OnDelta): Promise<ChatResult> {
    const body = { ...this.buildBody(req), stream: true }
    const opts: PostOpts = {}
    if (this.cfg.fetchFn) opts.fetchFn = this.cfg.fetchFn

    let text = ''
    let stopReason: string | undefined
    const usage: { inTokens: number; outTokens: number } = { inTokens: 0, outTokens: 0 }
    await streamSse(`${this.baseUrl}/v1/messages`, body, this.headers(), data => {
      let evt: AnthropicStreamEvent
      try { evt = JSON.parse(data) as AnthropicStreamEvent } catch { return } // skip unparseable frames
      if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta' && typeof evt.delta.text === 'string') {
        text += evt.delta.text
        if (evt.delta.text) onDelta(evt.delta.text)
      } else if (evt.type === 'message_start' && evt.message?.usage?.input_tokens != null) {
        usage.inTokens = evt.message.usage.input_tokens
      } else if (evt.type === 'message_delta') {
        if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason
        if (evt.usage?.output_tokens != null) usage.outTokens = evt.usage.output_tokens
      }
    }, opts)

    const result: ChatResult = {}
    if (text) result.text = text
    if (stopReason) result.stopReason = stopReason
    if (usage.inTokens || usage.outTokens) result.usage = usage
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
