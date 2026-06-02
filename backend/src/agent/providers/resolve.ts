import { CATALOG, type ProviderId } from './catalog.js'

/**
 * Prefix sniff to detect a provider from a bare API key. Order matters:
 * `sk-ant-` and `sk-or-` must be checked before the generic `sk-`.
 */
export function detectProviderFromKey(key: string): Exclude<ProviderId, 'mock'> | undefined {
  if (key.startsWith('sk-ant-')) return 'anthropic'
  if (key.startsWith('AIza')) return 'google'
  if (key.startsWith('sk-or-')) return 'openrouter'
  if (key.startsWith('sk-')) return 'openai'
  return undefined
}

/** Resolve the model id: explicit > catalog default. `||` (not `??`) so an EMPTY model
 *  — e.g. an unset `AI_MODEL=` in a .env, or a blank "(default)" picker value — falls
 *  back to the catalog default rather than sending "" to a provider API (which 400s). */
export function resolveModel(provider: Exclude<ProviderId, 'mock'>, model: string | undefined): string {
  return model || CATALOG[provider].defaultModel
}
