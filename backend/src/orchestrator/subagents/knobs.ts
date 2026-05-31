import type { LlmProvider } from '../../agent/LlmProvider.js'
import type { MockKnobs } from '../../agent/mock/MockProvider.js'

/**
 * Extract deterministic-scenario knobs from a provider, if it exposes them
 * (the MockProvider does). A real provider has no knobs → returns {}, and the
 * sub-agents fall back to parsing the model's actual output (deferred to the
 * real-AI sub-project).
 */
export function getKnobs(provider: LlmProvider): MockKnobs {
  return (provider as { knobs?: MockKnobs }).knobs ?? {}
}
