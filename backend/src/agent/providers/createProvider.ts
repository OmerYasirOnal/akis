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
  /** Explicit opt-in to the mock OUTSIDE tests (e.g. a demo flag). Default false. */
  allowMock?: boolean
}

/**
 * Thrown when a real provider cannot be resolved outside `NODE_ENV=test` and the
 * caller did not explicitly opt into the mock. FAIL-CLOSED (X-AC6 / CF6): a
 * misconfigured provider must never silently fall back to the mock in production
 * and emit fake "verified" output.
 */
export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProviderConfigError'
  }
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
 * True when a REAL provider+key can be resolved from env (or the KeyStore) without
 * the mock — i.e. `createProvider` would build a live provider rather than throw.
 * Used by the self-host boot to make `AKIS_ALLOW_MOCK` a FALLBACK, not a force:
 * the keyless demo runs the mock, but the moment a real key is supplied it takes
 * over (the documented "add a provider key, then `docker compose up` again" path),
 * so the demo flag never masks a configured key. Mirrors createProvider's
 * resolution but performs NO key validation and NEVER logs the key.
 */
export function hasRealProviderKey(
  env: Record<string, string | undefined>,
  keyStore?: KeyLookup,
): boolean {
  const forced = env.AI_PROVIDER as string | undefined
  // Explicitly named real provider: a key from its env var, the generic AI_API_KEY,
  // or the KeyStore satisfies it.
  if (isRealProvider(forced)) {
    return Boolean(firstPresentKey(env, forced) ?? env.AI_API_KEY ?? keyStore?.get(forced))
  }
  // Unknown/invalid forced provider can never resolve a real provider.
  if (forced && forced !== 'mock') return false
  // Auto-detect: any per-provider env key, or any KeyStore-held key.
  if (anyKey(env)) return true
  if (keyStore) {
    for (const provider of Object.keys(CATALOG) as RealProvider[]) {
      if (keyStore.get(provider)) return true
    }
  }
  return false
}

/**
 * The single provider swap point. Resolution:
 *   provider = opts.provider > env.AI_PROVIDER > detectProviderFromKey(any present key)
 *   model    = opts.model    > env.AI_MODEL    > catalog default
 *   key      = opts.apiKey   > first present keyEnvVar > KeyStore
 *
 * FAIL-CLOSED (X-AC6 / CF6): the ONLY implicit mock is `NODE_ENV==='test'`.
 * Outside tests, the mock is used ONLY when explicitly opted in (`allowMock` or
 * provider 'mock'). Anything else that cannot resolve a real provider+key —
 * unknown provider, missing key — THROWS `ProviderConfigError` rather than
 * silently producing fake "verified" output. Never logs the key.
 *
 * Default provider: with `ANTHROPIC_API_KEY` present and nothing else set, the
 * platform runs live on Claude out of the box (CORE-AC2), because anyKey() probes
 * the catalog and Anthropic's key is the natural default.
 */
export function createProvider(opts: CreateProviderOpts = {}): LlmProvider {
  const env = opts.env ?? (process.env as Record<string, string | undefined>)
  if (env.NODE_ENV === 'test') return new MockProvider()

  const forced = opts.provider ?? (env.AI_PROVIDER as string | undefined)
  if (forced === 'mock' || opts.allowMock) return new MockProvider()
  if (forced && !isRealProvider(forced)) {
    throw new ProviderConfigError(`Unknown AI_PROVIDER '${forced}'. Use one of: anthropic, openai, openrouter, google, mock.`)
  }

  let apiKey = opts.apiKey
  let real: RealProvider | undefined = isRealProvider(forced) ? forced : undefined
  if (!real) {
    real = apiKey ? detectProviderFromKey(apiKey) : anyKey(env)?.provider
  }
  if (!real) {
    throw new ProviderConfigError('No AI provider configured. Set ANTHROPIC_API_KEY (or another provider key) in env or the KeyStore, or pass allowMock for the mock.')
  }
  // Key resolution: explicit arg > per-provider env var > KeyStore > generic AI_API_KEY.
  // AI_API_KEY is only honored when the provider was named explicitly (opts.provider
  // or AI_PROVIDER), so a generic key is never applied to the wrong provider.
  if (!apiKey) apiKey = firstPresentKey(env, real) ?? opts.keyStore?.get(real)
  if (!apiKey && isRealProvider(forced)) apiKey = env.AI_API_KEY
  if (!apiKey) {
    throw new ProviderConfigError(`Provider '${real}' selected but no API key found (env ${CATALOG[real].keyEnvVars.join('/')}, AI_API_KEY, or KeyStore).`)
  }

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
    default: {
      // Exhaustiveness: `real` is a RealProvider and every case is handled, so this
      // is unreachable. Assert it at the type level so adding a provider without a
      // case is a COMPILE error — and fail LOUD (never silent mock) if ever hit.
      const _exhaustive: never = real
      throw new ProviderConfigError(`Unhandled provider '${String(_exhaustive)}'.`)
    }
  }
}
