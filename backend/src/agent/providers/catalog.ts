export type ProviderId = 'anthropic' | 'openai' | 'openrouter' | 'google' | 'mock'

export interface ModelInfo {
  id: string
  label: string
  recommended?: boolean
}

export interface ProviderInfo {
  id: Exclude<ProviderId, 'mock'>
  label: string
  baseUrl: string
  keyEnvVars: string[] // env vars that supply this provider's key
  defaultModel: string // the loop default (cost/speed-optimized)
  models: ModelInfo[]
}

/**
 * Single source of truth for provider + model identity. The loop default is the
 * cheapest/fastest model; the `recommended` badge (for the future ModelPicker)
 * may differ. Dated Anthropic IDs are pinned for reproducibility.
 */
export const CATALOG: Record<Exclude<ProviderId, 'mock'>, ProviderInfo> = {
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    baseUrl: 'https://api.anthropic.com',
    keyEnvVars: ['ANTHROPIC_API_KEY'],
    defaultModel: 'claude-haiku-4-5-20251001',
    models: [
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', recommended: true },
      { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
    ],
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    keyEnvVars: ['OPENAI_API_KEY'],
    defaultModel: 'gpt-4.1-mini',
    models: [
      { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini', recommended: true },
      { id: 'gpt-4.1-nano', label: 'GPT-4.1 nano' },
      { id: 'gpt-5-mini', label: 'GPT-5 mini' },
    ],
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyEnvVars: ['OPENROUTER_API_KEY'],
    defaultModel: 'anthropic/claude-haiku-4.5',
    models: [
      { id: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5 (OpenRouter)', recommended: true },
      { id: 'openai/gpt-4.1-mini', label: 'GPT-4.1 mini (OpenRouter)' },
    ],
  },
  google: {
    id: 'google',
    label: 'Google (Gemini)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    keyEnvVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    defaultModel: 'gemini-2.5-flash',
    models: [
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', recommended: true },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    ],
  },
}

export const REAL_PROVIDERS = Object.keys(CATALOG) as Exclude<ProviderId, 'mock'>[]

/** A semantic-embedding model: id + its fixed output dimension (the embedded
 *  EmbeddingProvider's `dim`). Lives in the SAME catalog as the chat models so a
 *  real API-backed embedder reuses the existing key/provider identity (no second
 *  catalog, no second key system). */
export interface EmbeddingModelInfo {
  id: string
  label: string
  /** Output vector dimension — the active `EmbeddingProvider.dim` (never hardcoded downstream). */
  dim: number
}

export interface EmbeddingProviderInfo {
  /** Reuses the chat provider id, so the SAME catalog key resolves the SAME stored key. */
  provider: Exclude<ProviderId, 'mock'>
  baseUrl: string
  defaultModel: string
  models: EmbeddingModelInfo[]
}

/**
 * Embedding-model catalog (single source of truth for embedding identity + dim).
 * Default is OpenAI `text-embedding-3-small` (dim 1536) — the API-backed semantic
 * embedder used when its key resolves; otherwise the offline LocalEmbeddingProvider
 * (signed feature hashing) stays the default so the suite + golden eval stay
 * deterministic and offline. The provider id matches the chat catalog (`openai`),
 * so the key is resolved from the SAME env vars / KeyStore as the chat provider.
 */
export const EMBEDDING_CATALOG: Record<'openai', EmbeddingProviderInfo> = {
  openai: {
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'text-embedding-3-small',
    models: [
      { id: 'text-embedding-3-small', label: 'OpenAI text-embedding-3-small', dim: 1536 },
      { id: 'text-embedding-3-large', label: 'OpenAI text-embedding-3-large', dim: 3072 },
    ],
  },
}

/** The default embedding model id (OpenAI text-embedding-3-small, dim 1536). */
export const DEFAULT_EMBEDDING_MODEL = EMBEDDING_CATALOG.openai.defaultModel

/** Look up an embedding model's dimension; falls back to the default model's dim for an
 *  unknown id (a misconfigured AKIS_EMBEDDING_MODEL must never crash boot). */
export function embeddingDimFor(modelId: string): number {
  const found = EMBEDDING_CATALOG.openai.models.find(m => m.id === modelId)
  return found?.dim ?? EMBEDDING_CATALOG.openai.models.find(m => m.id === DEFAULT_EMBEDDING_MODEL)!.dim
}
