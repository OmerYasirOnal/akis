import type { ApiClient, ProviderInfo } from './client.js'

/**
 * Per-ApiClient cache of the SESSION-STABLE data the chat header needs — the provider catalog and the
 * server mode (live/demo). AkisChat remounts once per build/reopen (a threadKey bump), and audit #41
 * flagged that each remount re-fetched `/api/providers` + `/health` even though neither changes
 * between remounts. We memoize the in-flight promise PER ApiClient instance (a WeakMap) so the many
 * remounts that share one client share ONE request, while a different client — a different user/token,
 * or a fresh test — never reuses another's data. The cache is invalidated EXPLICITLY when the user
 * mutates a provider key (availability flips), so it never goes stale the one way it actually could.
 * Token usage is deliberately NOT cached — it changes per build, so callers fetch `/api/usage` directly.
 *
 * A rejected fetch clears its own slot so the next mount retries (no poisoned cache).
 */
interface Slot {
  providers?: Promise<ProviderInfo[]>
  mode?: Promise<'live' | 'demo' | undefined>
}
const cache = new WeakMap<ApiClient, Slot>()

function slotFor(api: ApiClient): Slot {
  let s = cache.get(api)
  if (!s) { s = {}; cache.set(api, s) }
  return s
}

/** The provider catalog, fetched at most once per client until invalidated. */
export function getProvidersCached(api: ApiClient): Promise<ProviderInfo[]> {
  const s = slotFor(api)
  if (!s.providers) {
    s.providers = api.listProviders().catch(e => { delete s.providers; throw e })
  }
  return s.providers
}

/** The server mode (live/demo), fetched at most once per client. Undefined if /health reports no mode. */
export function getModeCached(api: ApiClient): Promise<'live' | 'demo' | undefined> {
  const s = slotFor(api)
  if (!s.mode) {
    s.mode = api.health()
      .then(h => (h?.mode === 'live' || h?.mode === 'demo') ? h.mode : undefined)
      .catch(e => { delete s.mode; throw e })
  }
  return s.mode
}

/** Drop this client's cache so the next read re-fetches — call after a provider-key mutation. */
export function invalidateProvidersCache(api: ApiClient): void {
  cache.delete(api)
}
