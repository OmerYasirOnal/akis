import type { ChatMessage, ChatRequest, ChatResult, LlmProvider, ToolCall } from '../LlmProvider.js'
import type { ToolRegistry } from './ToolRegistry.js'

export interface ToolLoopOptions {
  /** Max provider round-trips before returning the latest result as-is (default 4). */
  maxTurns?: number
  /** Observe each dispatched tool call + its (string) result — for event narration. */
  onTool?: (call: ToolCall, result: string) => void
}

const DEFAULT_MAX_TURNS = 4

/**
 * Run a bounded, provider-agnostic tool-use loop: advertise the registry's tools,
 * dispatch any tool calls the model makes, feed the results back, and repeat until
 * the model answers WITHOUT a tool call or the turn budget is spent.
 *
 * - Provider-agnostic: it only touches the normalized ToolCall/ChatMessage shapes,
 *   so the same loop works across Anthropic/OpenAI/Gemini adapters.
 * - Fail-safe: a handler error (or an unknown tool) is fed back to the model AS a
 *   tool result rather than thrown, so the loop never crashes the caller.
 * - No authority: only tools in the registry can run, and the registry never holds
 *   a gate capability — so this cannot reach a structural gate.
 */
export async function callWithTools(
  provider: LlmProvider,
  req: ChatRequest,
  registry: ToolRegistry,
  opts: ToolLoopOptions = {},
): Promise<ChatResult> {
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS
  const specs = registry.specs()
  const messages: ChatMessage[] = [...req.messages]
  let res: ChatResult = {}

  for (let turn = 1; turn <= maxTurns; turn++) {
    res = await provider.chat({ ...req, messages, tools: specs })
    if (!res.toolCalls?.length) return res
    if (turn === maxTurns) return res // budget spent — hand back the last result as-is

    // Reconstruct the assistant turn (so the provider can correlate the results)…
    messages.push({ role: 'assistant', content: res.text ?? '', toolCalls: res.toolCalls })
    // …then run each tool call and append its result.
    for (const call of res.toolCalls) {
      let result: string
      try {
        result = await registry.call(call.name, call.args)
      } catch (e) {
        result = `Error: ${e instanceof Error ? e.message : String(e)}`
      }
      const toolMsg: ChatMessage = { role: 'tool', content: result, toolName: call.name }
      if (call.id !== undefined) toolMsg.toolCallId = call.id // OpenAI/Anthropic correlate by id; Gemini by name
      messages.push(toolMsg)
      opts.onTool?.(call, result)
    }
  }
  return res
}
