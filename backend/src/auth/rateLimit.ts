/**
 * Sliding-window rate limiter for the BRUTE-FORCE surfaces (login/signup/reset) — the
 * audit's "no rate limiting" gap. In-memory by design: this is per-process abuse
 * damping (scrypt cost amplification, credential stuffing), not a distributed quota —
 * a multi-replica deployment puts a real limiter at the edge.
 *
 * Pure + injectable clock (tests never sleep). Windows are pruned lazily on hit, and a
 * periodic sweep bounds the map so an attacker rotating keys can't grow memory forever.
 */
export interface RateLimiter {
  /** Record an attempt for `key`; returns retry-after seconds when OVER the limit (else undefined). */
  hit(key: string): number | undefined
}

export function createRateLimiter(opts: { max: number; windowMs: number; now?: () => number }): RateLimiter {
  const now = opts.now ?? Date.now
  const hits = new Map<string, number[]>()
  let lastSweep = now()
  return {
    hit(key: string): number | undefined {
      const t = now()
      // Lazy global sweep (at most once per window): drop fully-expired keys so rotating
      // keys can't grow the map unboundedly.
      if (t - lastSweep >= opts.windowMs) {
        lastSweep = t
        for (const [k, arr] of hits) { if ((arr[arr.length - 1] ?? 0) <= t - opts.windowMs) hits.delete(k) }
      }
      const cutoff = t - opts.windowMs
      const arr = (hits.get(key) ?? []).filter(x => x > cutoff)
      if (arr.length >= opts.max) {
        hits.set(key, arr) // do NOT count rejected attempts — the window drains while they back off
        return Math.max(1, Math.ceil(((arr[0] ?? t) + opts.windowMs - t) / 1000))
      }
      arr.push(t)
      hits.set(key, arr)
      return undefined
    },
  }
}
