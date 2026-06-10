import { ApiError } from '../api/client.js'
import type { StringKey } from '../i18n/catalog.js'

/**
 * Render a gate/recovery action failure for the studio's error banner. Centralizes the
 * `${e.code ?? 'error'}: ${e.message}` shape that used to be inlined at every catch site, and —
 * crucially — maps KNOWN backend error codes to a LOCALIZED message instead of leaking the raw
 * English provider string.
 *
 * Today the only mapped code is `GitHubDeliveryError` from POST /sessions/:id/confirm: a 429
 * (upstream rate-limit, transient — the destination is fine) gets `recovery.push.rateLimited`,
 * any other delivery failure (a 422: missing/invalid repo, bad token) gets
 * `recovery.push.deliveryFailed` instead of "github: request to /git/blobs failed (HTTP 404)".
 * Any other ApiError falls back to the existing `code: message` form, and a non-ApiError to its
 * string — byte-identical to before.
 *
 * Gate-neutral: this only reshapes how a failure is DISPLAYED; the push gate already parked the run
 * push_failed (retryable) server-side.
 */
export function actionErrorText(e: unknown, t: (k: StringKey) => string): string {
  if (ApiError.is(e)) {
    if (e.code === 'GitHubDeliveryError') {
      return t(e.status === 429 ? 'recovery.push.rateLimited' : 'recovery.push.deliveryFailed')
    }
    // No connected GitHub delivery target (a real-mode push refused, NOT a fake mock success):
    // guide the user to Settings → GitHub instead of leaking the backend's raw English message.
    if (e.code === 'NoGitHubDestinationError') {
      return t('recovery.push.notConnected')
    }
    return `${e.code ?? 'error'}: ${e.message}`
  }
  return String(e)
}
