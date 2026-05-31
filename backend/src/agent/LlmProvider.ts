import type { Role } from '@akis/shared'

export interface ToolSpec { name: string; description: string; schema: unknown }
export interface ChatMessage { role: 'user' | 'assistant' | 'tool'; content: string; toolName?: string }
export interface ChatRequest { role: Role; system: string; messages: ChatMessage[]; tools: ToolSpec[] }
export interface ToolCall { name: string; args: unknown }
export interface ChatResult { text?: string; toolCalls?: ToolCall[]; usage?: { inTokens: number; outTokens: number } }

export interface LlmProvider {
  readonly name: string
  chat(req: ChatRequest): Promise<ChatResult>
}
