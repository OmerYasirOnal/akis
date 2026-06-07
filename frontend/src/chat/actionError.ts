import { ApiError } from '../api/client.js'
import type { StringKey } from '../i18n/catalog.js'

/**
 * Render a gate/recovery action failure for the studio's error banner. Centralizes the
 * `${e.code ?? 'error'}: ${e.message}` shape that used to be inlined at every catch site, and —
 * crucially — maps KNOWN backend error codes to a LOCALIZED message instead of leaking the raw
 * English provider string.
 *
 * Today the only mapped code is `GitHubDeliveryError` (a 422 from POST /sessions/:id/confirm when
 * the GitHub push destination is missing/invalid): the FE shows the localized `push.deliveryFailed`
 * instead of "github: request to /git/blobs failed (HTTP 404)". Any other ApiError falls back to the
 * existing `code: message` form, and a non-ApiError to its string — byte-identical to before.
 *
 * Gate-neutral: this only reshapes how a failure is DISPLAYED; the push gate already parked the run
 * push_failed (retryable) server-side.
 */
export function actionErrorText(e: unknown, t: (k: StringKey) => string): string {
  if (ApiError.is(e)) {
    if (e.code === 'GitHubDeliveryError') return t('push.deliveryFailed')
    return `${e.code ?? 'error'}: ${e.message}`
  }
  return String(e)
}
