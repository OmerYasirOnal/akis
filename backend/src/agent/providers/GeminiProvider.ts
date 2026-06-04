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
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[]
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
    // generationConfig parity (Anthropic/OpenAI pass these): map the common
    // request fields to Gemini's names; omit the key entirely when unset so the
    // API keeps its own defaults (backward compatible).
    const generationConfig: Record<string, unknown> = {}
    if (req.temperature !== undefined) generationConfig.temperature = req.temperature
    // Clamp to a safe ceiling so a generous request degrades, never 400s. 65 536 matches the
    // catalog's Gemini 2.5 Flash/Pro output limit — the previous 8 192 clamp silently HALVED
    // Proto's 16 384 budget and guaranteed truncation (→ placeholder stub) on any moderate app.
    // A model that still stops on MAX_TOKENS is recovered by chatWithContinuation upstream.
    if (req.maxTokens !== undefined) generationConfig.maxOutputTokens = Math.min(req.maxTokens, 65536)
    if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig

    const opts: PostOpts = {}
    if (this.cfg.fetchFn) opts.fetchFn = this.cfg.fetchFn
    const url = `${this.baseUrl}/models/${req.model?.trim() || this.model}:generateContent` // trim+`||`: empty/blank model falls back, never a malformed "/models/ :…"

    let res: GeminiResponse
    try {
      res = await postJson<GeminiResponse>(url, body, { 'x-goog-api-key': this.cfg.apiKey }, opts)
    } catch (e) {
      // Gemini reports bad keys as 400 PERMISSION_DENIED / API_KEY_INVALID (not 401).
      // Map ONLY those to AuthError; let INVALID_ARGUMENT (request-shape bugs)
      // surface as a real ProviderHttpError so they stay debuggable.
      if (e instanceof ProviderHttpError && e.status === 400 && /PERMISSION_DENIED|API_KEY_INVALID/i.test(e.body)) {
        throw new AuthError('Gemini PERMISSION_DENIED / API_KEY_INVALID')
      }
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
    // Pass Gemini's raw finishReason ('STOP' | 'MAX_TOKENS' | 'SAFETY' | ...) as
    // stopReason, consistent with how Anthropic forwards its raw stop_reason.
    const finishReason = res.candidates?.[0]?.finishReason
    if (finishReason) result.stopReason = finishReason
    return result
  }

  private mapMessage(m: ChatMessage): Record<string, unknown> {
    if (m.role === 'tool') {
      // Gemini correlates a functionResponse to the prior functionCall BY NAME;
      // a missing name would silently mis-route, so require it explicitly.
      if (!m.toolName) throw new Error('Gemini tool result requires toolName (correlated by function name)')
      return { role: 'user', parts: [{ functionResponse: { name: m.toolName, response: { result: m.content } } }] }
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
