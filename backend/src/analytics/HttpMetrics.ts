/**
 * Cumulative HTTP response counters by status class + a headline error rate. Fed by a single
 * global `onResponse` hook (server.ts). Pure process-lifetime counters — no per-request state
 * retained, no bodies/paths/headers touched — so it's cheap, leak-free, and carries NOTHING
 * sensitive (only counts). Observability only: never a gate input.
 *
 * Why: OpsBlock tracks build lifecycle + process health but nothing counted HTTP outcomes, so an
 * operator couldn't see "X% of requests are failing" or a spike in 429s (rate/quota/concurrency
 * refusals) without grepping raw logs. Surfaced on the authed /api/ops operator view.
 */
export interface HttpMetricsSnapshot {
  total: number
  ok: number            // 2xx
  redirect: number      // 3xx
  clientError: number   // 4xx (includes 429)
  serverError: number   // 5xx
  tooManyRequests: number // 429 specifically — the abuse-guard refusal signal
  /** (clientError + serverError) / total, rounded to 3 dp; 0 when no requests yet (never NaN).
   *  NOTE: this includes benign 4xx (401 auth challenges, 404 probes, 409 lock conflicts, 429
   *  rate-limits), so it's a NOISY headline — alert on `serverErrorRate` (real failures) and
   *  read the raw per-class counts for detail. */
  errorRate: number
  /** serverError / total (5xx only) — the "real service failure" rate an operator should alert
   *  on; excludes client-caused 4xx. Rounded to 3 dp; 0 when no requests yet. */
  serverErrorRate: number
}

export class HttpMetrics {
  private total = 0
  private ok = 0
  private redirect = 0
  private clientError = 0
  private serverError = 0
  private tooManyRequests = 0

  /** Record one response's status code. Defensive: an unrecognized/NaN status still counts
   *  toward `total` but lands in no class bucket (so buckets always sum to a real HTTP class). */
  observe(status: number): void {
    this.total++
    if (!Number.isFinite(status)) return
    if (status === 429) this.tooManyRequests++
    if (status >= 200 && status < 300) this.ok++
    else if (status >= 300 && status < 400) this.redirect++
    else if (status >= 400 && status < 500) this.clientError++
    else if (status >= 500 && status < 600) this.serverError++
  }

  snapshot(): HttpMetricsSnapshot {
    const rate = (n: number): number => (this.total > 0 ? Math.round((n / this.total) * 1000) / 1000 : 0)
    return {
      total: this.total,
      ok: this.ok,
      redirect: this.redirect,
      clientError: this.clientError,
      serverError: this.serverError,
      tooManyRequests: this.tooManyRequests,
      errorRate: rate(this.clientError + this.serverError),
      serverErrorRate: rate(this.serverError),
    }
  }
}
