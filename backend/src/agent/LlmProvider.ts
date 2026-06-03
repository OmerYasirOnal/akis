/**
 * The provider seam. Every LLM provider (Anthropic/OpenAI/OpenRouter/Gemini) and
 * the MockProvider implement this one interface; everything above it is
 * provider-agnostic. Swapping providers changes only which adapter is constructed
 * (see createProvider).
 *
 * Tool-calling is first-class so the agent loop can dispatch model tool calls.
 *
 * Streaming is an OPTIONAL second method: a provider MAY implement `chatStream` to
 * push text deltas as they arrive (the persona chat uses this to feel alive). It is
 * optional so a provider without it — and every non-streaming caller (the agents) —
 * keeps working through `chat`; callers fall back to `chat` when `chatStream` is absent.
 */
export interface ToolSpec {
  name: string
  description: string
  schema: unknown // JSON Schema passed straight through to each provider
}

export interface ToolCall {
  name: string
  args: unknown
  /** Provider-assigned id (Anthropic toolu_…, OpenAI call_…); synthesized if absent. */
  id?: string
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolName?: string
  /** On a role:'tool' message — correlates the result to the assistant tool call. */
  toolCallId?: string
  /** On a role:'assistant' message — the tool calls made that turn (to reconstruct the turn). */
  toolCalls?: ToolCall[]
}

export interface ChatRequest {
  system: string
  messages: ChatMessage[]
  tools?: ToolSpec[]
  model?: string
  maxTokens?: number
  temperature?: number
}

export interface ChatResult {
  text?: string
  toolCalls?: ToolCall[]
  usage?: { inTokens: number; outTokens: number }
  stopReason?: string
}

/** Sink for streamed text deltas — called once per chunk as it arrives. */
export type OnDelta = (delta: string) => void

export interface LlmProvider {
  readonly name: string
  readonly model: string
  chat(req: ChatRequest): Promise<ChatResult>
  /**
   * OPTIONAL token-by-token streaming. Calls `onDelta(chunk)` as text arrives and
   * resolves with the final assembled ChatResult (text = the concatenation of all
   * deltas) — so a caller can stream live AND still get the full reply for spec
   * detection. MUST use the SAME request/message assembly as `chat`. Absent on
   * providers that don't stream; callers fall back to `chat` in that case.
   */
  chatStream?(req: ChatRequest, onDelta: OnDelta): Promise<ChatResult>
}
