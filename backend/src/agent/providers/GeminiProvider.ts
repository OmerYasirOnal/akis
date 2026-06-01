import type { LlmProvider, ChatRequest, ChatResult, ChatMessage, ToolCall } from '../LlmProvider.js'
import { postJson, AuthError, ProviderHttpError, type PostOpts } from './http.js'

interface GeminiConfig {
  apiKey: string
  model: string
  baseUrl?: string
  fetchFn?: typeof fetch
}

interface GeminiPart {
  text?: string
  functionCall?: { name: string; args?: unknown; id?: string }
}
interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] } }[]
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
}

/**
 * Google Gemini (Developer API) adapter.
 * - Auth via `x-goog-api-key`; model in the URL path (`:generateContent`).
 * - `systemInstruction` carries the system prompt; roles are strictly user/model.
 * - Tools use `functionDeclarations`; tool calls return as `functionCall` parts
 *   whose `args` are already objects. Tool results are user `functionResponse`
 *   parts whose `response` MUST be an object.
 * - Auth failure may surface as 400 PERMISSION_DENIED (mapped to AuthError).
 */
export class GeminiProvider implements LlmProvider {
  readonly name = 'google'
  readonly model: string
  private baseUrl: string

  constructor(private cfg: GeminiConfig) {
    this.model = cfg.model
    this.baseUrl = cfg.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta'
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: req.messages.map(m => this.mapMessage(m)),
    }
    if (req.tools?.length) {
      body.tools = [{ functionDeclarations: req.tools.map(t => ({ name: t.name, description: t.description, parameters: t.schema })) }]
    }

    const opts: PostOpts = {}
    if (this.cfg.fetchFn) opts.fetchFn = this.cfg.fetchFn
    const url = `${this.baseUrl}/models/${req.model ?? this.model}:generateContent`

    let res: GeminiResponse
    try {
      res = await postJson<GeminiResponse>(url, body, { 'x-goog-api-key': this.cfg.apiKey }, opts)
    } catch (e) {
      // Gemini reports bad keys as 400 PERMISSION_DENIED, not 401.
      if (e instanceof ProviderHttpError && e.status === 400) throw new AuthError('Gemini 400 (likely PERMISSION_DENIED)')
      throw e
    }

    const parts = res.candidates?.[0]?.content?.parts ?? []
    const text = parts.map(p => p.text ?? '').join('')
    const toolCalls: ToolCall[] = parts
      .filter((p): p is GeminiPart & { functionCall: NonNullable<GeminiPart['functionCall']> } => !!p.functionCall)
      .map(p => {
        const tc: ToolCall = { name: p.functionCall.name, args: p.functionCall.args ?? {} }
        if (p.functionCall.id) tc.id = p.functionCall.id
        return tc
      })

    const result: ChatResult = {}
    if (text) result.text = text
    if (toolCalls.length) result.toolCalls = toolCalls
    if (res.usageMetadata) {
      result.usage = { inTokens: res.usageMetadata.promptTokenCount ?? 0, outTokens: res.usageMetadata.candidatesTokenCount ?? 0 }
    }
    return result
  }

  private mapMessage(m: ChatMessage): Record<string, unknown> {
    if (m.role === 'tool') {
      return { role: 'user', parts: [{ functionResponse: { name: m.toolName ?? 'tool', response: { result: m.content } } }] }
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const parts: Record<string, unknown>[] = []
      if (m.content) parts.push({ text: m.content })
      for (const tc of m.toolCalls) parts.push({ functionCall: { name: tc.name, args: tc.args ?? {} } })
      return { role: 'model', parts }
    }
    return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }
  }
}
