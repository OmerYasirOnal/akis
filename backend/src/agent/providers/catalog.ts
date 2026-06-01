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
