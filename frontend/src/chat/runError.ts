import type { StringKey } from '../i18n/catalog.js'

/**
 * Map a run `kind:'error'` event's machine code to a localized headline key (B6-ii) — the
 * sibling of actionError.ts (gate-action HTTP errors) for the SSE error path, which used to
 * render only the backend's raw English message. The raw message is KEPT as secondary detail
 * (ErrorBubble); this mapping only adds a user-language headline. An unknown/absent code maps
 * to nothing — the bubble then renders exactly as before (no invented copy).
 */
const RUN_ERROR_KEYS: Record<string, StringKey> = {
  PushFailed: 'run.error.pushFailed', // Orchestrator confirmPush delivery failure
  RunFailed: 'run.error.runFailed',   // generic pipeline RunFailed
}

export function runErrorKey(code: string | undefined): StringKey | undefined {
  if (code === undefined) return undefined
  // All four CriticAgent error codes (CRITIC_AI_ERROR / _PARSE_ERROR / _INVALID_INPUT /
  // _MISSING_SPEC) share one user-facing headline — the distinction lives in the raw detail.
  if (code.startsWith('CRITIC_')) return 'run.error.critic'
  return RUN_ERROR_KEYS[code]
}
