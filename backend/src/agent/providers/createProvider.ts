import type { LlmProvider } from '../LlmProvider.js'
import { CATALOG, type ProviderId } from './catalog.js'
import { detectProviderFromKey, resolveModel } from './resolve.js'
import { MockProvider } from './mock/MockProvider.js'
import { AnthropicProvider } from '../providers/AnthropicProvider.js'
import { OpenAiCompatibleProvider } from '../providers/OpenAiCompatibleProvider.js'
import { GeminiProvider } from '../providers/GeminiProvider.js'

/** Optional key source consulted AFTER env (e.g. the encrypted KeyStore). */
export interface KeyLookup {
  get(provider: string): string | undefined
}

export interface CreateProviderOpts {
  provider?: ProviderId
  model?: string
  apiKey?: string
  env?: Record<string, string | undefined>
  /** Consulted after env keys — lets stored (Settings) keys reach a provider. */
  keyStore?: KeyLookup
}

type RealProvider = Exclude<ProviderId, 'mock'>

function isRealProvider(p: string | undefined): p is RealProvider {
  return p === 'anthropic' || p === 'openai' || p === 'openrouter' || p === 'google'
}

function firstPresentKey(env: Record<string, string | undefined>, provider: RealProvider): string | undefined {
  for (const v of CATALOG[provider].keyEnvVars) {
    const val = env[v]
    if (val) return val
  }
  return undefined
}

function anyKey(env: Record<string, string | undefined>): { provider: RealProvider; key: string } | undefined {
  for (const provider of Object.keys(CATALOG) as RealProvider[]) {
    const key = firstPresentKey(env, provider)
    if (key) return { provider, key }
  }
  return undefined
}

/**
 * The single provider swap point. Resolution:
 *   provider = opts.provider > env.AI_PROVIDER > detectProviderFromKey(any present key)
 *   model    = opts.model    > env.AI_MODEL    > catalog default
 *   key      = opts.apiKey   > first present keyEnvVar for the provider
 *
 * FAIL-SAFE: returns a MockProvider when NODE_ENV==='test', or when no provider
 * or no key can be resolved. This keeps the whole test suite + smoke green with
 * zero env, and degrades gracefully in production until a key is configured.
 * Never logs the key.
 */
export function createProvider(opts: CreateProviderOpts = {}): LlmProvider {
  const env = opts.env ?? (process.env as Record<string, string | undefined>)
  if (env.NODE_ENV === 'test') return new MockProvider()

  const forced = opts.provider ?? (env.AI_PROVIDER as string | undefined)
  if (forced === 'mock') return new MockProvider()
  // An unrecognized AI_PROVIDER must not crash — fail safe to mock.
  if (forced && !isRealProvider(forced)) return new MockProvider()

  let apiKey = opts.apiKey
  let real: RealProvider | undefined = isRealProvider(forced) ? forced : undefined
  if (!real) {
    real = apiKey ? detectProviderFromKey(apiKey) : anyKey(env)?.provider
  }
  if (!real) return new MockProvider()
  // Key resolution: explicit arg > env > KeyStore.
  if (!apiKey) apiKey = firstPresentKey(env, real) ?? opts.keyStore?.get(real)
  if (!apiKey) return new MockProvider()

  const model = resolveModel(real, opts.model ?? env.AI_MODEL)
  const baseUrlOverride = env[`${real.toUpperCase()}_BASE_URL`]

  switch (real) {
    case 'anthropic':
      return new AnthropicProvider({ apiKey, model, ...(baseUrlOverride ? { baseUrl: baseUrlOverride } : {}) })
    case 'openai':
      return new OpenAiCompatibleProvider({ name: 'openai', apiKey, model, baseUrl: baseUrlOverride ?? CATALOG.openai.baseUrl })
    case 'openrouter':
      return new OpenAiCompatibleProvider({ name: 'openrouter', apiKey, model, baseUrl: baseUrlOverride ?? CATALOG.openrouter.baseUrl })
    case 'google':
      return new GeminiProvider({ apiKey, model, ...(baseUrlOverride ? { baseUrl: baseUrlOverride } : {}) })
    default:
      return new MockProvider()
  }
}
