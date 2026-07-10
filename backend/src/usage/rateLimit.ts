import type { FastifyReply, FastifyRequest } from 'fastify'
import { createRateLimiter, type RateLimiter } from '../auth/rateLimit.js'

/**
 * Route-layer request-RATE limiter (the abuse-guard sibling of quota.ts / concurrency.ts). The
 * quota bounds windowed token SPEND and the concurrency cap bounds simultaneous active runs, but
 * neither throttles request FREQUENCY — a caller with budget headroom (or an anonymous caller,
 * whom the concurrency cap exempts) could still flood the expensive endpoints. This adds a
 * per-caller requests-per-window cap on the compute/outward-call surfaces.
 *
 * SACRED, same contract as its siblings: it can only REFUSE at the route boundary (fail-closed
 * 429 BEFORE any orchestrator/provider/MCP work); it never weakens a gate, never mints/verifies/
 * pushes, and never reads or aborts an in-flight run. OPT-IN: absent AKIS_RATE_LIMIT the resolver
 * returns undefined and the routes omit the dep — the default path is byte-identical.
 *
 * In-memory per-process (like the auth limiter it reuses): this is per-replica abuse damping, not
 * a distributed quota — a multi-replica deployment puts a real limiter at the edge.
 */

/** The independent buckets, each its own sliding window. Kept coarse on purpose (one per
 *  risk class) so the config surface stays small. */
export interface RouteRateLimits {
  /** POST /sessions + /sessions/:id/approve — kicks a real orchestrator pipeline. */
  build: RateLimiter
  /** POST /api/chat + /api/chat/stream — a real LLM provider call per request. */
  chat: RateLimiter
  /** external-write propose + confirm — a real outward MCP/GitHub call per confirm. */
  externalWrite: RateLimiter
}

/** Sane per-window defaults applied ONLY when the layer is enabled. These are FLOOD guards, set
 *  generously so a legitimate user never trips them; an operator tightens via the *_MAX env. */
const DEFAULTS = {
  build: { max: 30, windowMs: 60_000 },
  chat: { max: 60, windowMs: 60_000 },
  externalWrite: { max: 30, windowMs: 60_000 },
} as const

function truthy(v: string | undefined): boolean {
  const s = (v ?? '').trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'on' || s === 'yes'
}

/** Positive-integer env override, else the default. */
function envInt(raw: string | undefined, def: number): number {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : def
}

/**
 * Resolve the route rate-limit layer from env. Returns undefined (⇒ layer off, dep omitted,
 * byte-identical default) unless AKIS_RATE_LIMIT is truthy. Per-bucket caps/windows override via
 * AKIS_RATE_LIMIT_<BUILD|CHAT|EXTWRITE>_MAX / _WINDOW_SEC.
 */
export function resolveRouteRateLimits(
  env: Record<string, string | undefined>,
  now?: () => number,
): RouteRateLimits | undefined {
  if (!truthy(env.AKIS_RATE_LIMIT)) return undefined
  const bucket = (prefix: string, def: { max: number; windowMs: number }): RateLimiter => {
    const max = envInt(env[`${prefix}_MAX`], def.max)
    const windowSecRaw = env[`${prefix}_WINDOW_SEC`]
    const windowMs = windowSecRaw !== undefined ? envInt(windowSecRaw, def.windowMs / 1000) * 1000 : def.windowMs
    return createRateLimiter({ max, windowMs, ...(now ? { now } : {}) })
  }
  return {
    build: bucket('AKIS_RATE_LIMIT_BUILD', DEFAULTS.build),
    chat: bucket('AKIS_RATE_LIMIT_CHAT', DEFAULTS.chat),
    externalWrite: bucket('AKIS_RATE_LIMIT_EXTWRITE', DEFAULTS.externalWrite),
  }
}

/** Rate-limit key: the authenticated owner (per-account) when present, else the client IP
 *  (per-anon). Prefixed so an owner id can never collide with an IP-shaped string. */
export function rateLimitKey(req: FastifyRequest, ownerId: string | undefined): string {
  return ownerId ? `u:${ownerId}` : `ip:${req.ip || 'unknown'}`
}

/**
 * If `key` is over `limiter`'s window, write a clean 429 {code:'RateLimited', retryAfter} + a
 * retry-after header and return true (the caller `return`s immediately). Else false — no write.
 * Mirrors the auth limiter's 429 shape/code so the FE maps it uniformly.
 */
export function overRouteLimit(limiter: RateLimiter, key: string, reply: FastifyReply): boolean {
  const retry = limiter.hit(key)
  if (retry === undefined) return false
  void reply.header('retry-after', String(retry)).code(429).send({ error: 'rate limit exceeded — slow down and try again', code: 'RateLimited', retryAfter: retry })
  return true
}
