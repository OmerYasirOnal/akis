import type { Effort } from './ModelChip.js'

/**
 * The user's CHAT-ONLY model preference (the model picker). Persisted in localStorage so it
 * survives a reload. Empty `provider`/`model` mean "AKIS default" — the server's default
 * provider is used and the request stays byte-identical to before the picker existed.
 *
 * SACRED: this is chat-only. It is applied ONLY to /api/chat[/stream]; it NEVER touches a
 * build (startSession/workflows), which keep their workflow bindings.
 */
export interface ModelPref {
  provider: string
  model: string
  effort: Effort
}

export const MODEL_PREF_KEY = 'akis_model_pref'

const EFFORTS = new Set<Effort>(['fast', 'balanced', 'deep'])

/** The safe default: AKIS default provider, balanced effort. */
export function defaultModelPref(): ModelPref {
  return { provider: '', model: '', effort: 'balanced' }
}

/**
 * Load the saved preference with SAFE JSON parsing: a missing key, corrupt JSON, or a
 * malformed shape ALL fall back to the default silently (never throws) so a poisoned
 * localStorage entry can't break the chat from loading.
 */
export function loadModelPref(): ModelPref {
  try {
    const raw = localStorage.getItem(MODEL_PREF_KEY)
    if (!raw) return defaultModelPref()
    const parsed = JSON.parse(raw) as Partial<ModelPref>
    return {
      provider: typeof parsed.provider === 'string' ? parsed.provider : '',
      model: typeof parsed.model === 'string' ? parsed.model : '',
      effort: parsed.effort && EFFORTS.has(parsed.effort) ? parsed.effort : 'balanced',
    }
  } catch {
    // Corrupt JSON or unavailable localStorage — degrade to the default silently.
    return defaultModelPref()
  }
}

/** Persist the preference (best-effort; a storage failure must never break the send). */
export function saveModelPref(pref: ModelPref): void {
  try { localStorage.setItem(MODEL_PREF_KEY, JSON.stringify(pref)) } catch { /* ignore */ }
}
