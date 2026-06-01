/**
 * The provider seam. Every LLM provider (Anthropic/OpenAI/OpenRouter/Gemini) and
 * the MockProvider implement this one interface; everything above it is
 * provider-agnostic. Swapping providers changes only which adapter is constructed
 * (see createProvider).
 *
 * Tool-calling is first-class so the agent loop can dispatch model tool calls.
 * Streaming is intentionally omitted for now (added as an optional method when
 * the live UI lands).
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

export interface LlmProvider {
  readonly name: string
  readonly model: string
  chat(req: ChatRequest): Promise<ChatResult>
}
