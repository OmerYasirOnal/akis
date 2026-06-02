import type { LlmProvider } from './LlmProvider.js'

/**
 * Adapts the critic's `generateText(system, user) → string` DI seam onto an
 * `LlmProvider`. This is the single point where the real provider feeds the
 * critic; everything else about the critic is unchanged.
 */
export function makeGenerateText(provider: LlmProvider) {
  return async (system: string, user: string): Promise<string> => {
    const r = await provider.chat({ system, messages: [{ role: 'user', content: user }] })
    return r.text ?? ''
  }
}
