/**
 * ESTIMATED model pricing for the analytics cost column. USD per 1M tokens (input, output).
 *
 * This is a NON-AUTHORITATIVE estimate for observability only — it is NEVER a gate input and never
 * affects a build. DATED below; verify against each provider's current price page. An unknown model
 * returns `{ known: false }` so the UI shows an honest "—" instead of inventing a number.
 */
export const MODEL_PRICING_DATED = '2026-06-07'

export interface ModelPrice {
  /** USD per 1M INPUT tokens. */ inUsdPer1M: number
  /** USD per 1M OUTPUT tokens. */ outUsdPer1M: number
}

/** Keyed by the SAME model ids the provider catalog uses. Values are public list-price estimates as
 *  of MODEL_PRICING_DATED (Anthropic figures are exact; others are rounded public estimates). */
export const MODEL_PRICING: Record<string, ModelPrice> = {
  // Anthropic (exact — Claude price list).
  'claude-opus-4-8': { inUsdPer1M: 5, outUsdPer1M: 25 },
  'claude-sonnet-4-6': { inUsdPer1M: 3, outUsdPer1M: 15 },
  'claude-haiku-4-5-20251001': { inUsdPer1M: 1, outUsdPer1M: 5 },
  // OpenAI (rounded public estimates).
  'gpt-4.1-mini': { inUsdPer1M: 0.4, outUsdPer1M: 1.6 },
  'gpt-4.1-nano': { inUsdPer1M: 0.1, outUsdPer1M: 0.4 },
  'gpt-5-mini': { inUsdPer1M: 0.25, outUsdPer1M: 2 },
  // Google (rounded public estimate).
  'gemini-2.5-flash': { inUsdPer1M: 0.3, outUsdPer1M: 2.5 },
  // OpenRouter passthroughs (mirror the upstream model).
  'anthropic/claude-haiku-4.5': { inUsdPer1M: 1, outUsdPer1M: 5 },
  'openai/gpt-4.1-mini': { inUsdPer1M: 0.4, outUsdPer1M: 1.6 },
}

/** Estimate the USD cost of a token spend on a model. Unknown/absent model ⇒ `{ usd: 0, known: false }`
 *  (the caller renders "—", never a fabricated 0). PURE — unit-tested. */
export function estimateCostUsd(model: string | undefined, inTokens: number, outTokens: number): { usd: number; known: boolean } {
  const p = model ? MODEL_PRICING[model] : undefined
  if (!p) return { usd: 0, known: false }
  return { usd: (inTokens * p.inUsdPer1M + outTokens * p.outUsdPer1M) / 1_000_000, known: true }
}
