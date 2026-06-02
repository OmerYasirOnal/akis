import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Single-container static serving of the built frontend (the self-host "like Ollama"
 * path). When enabled, the backend serves `frontend/dist` AND owns the SPA fallback so a
 * client deep-link reloads to index.html — while every API route stays untouched.
 *
 * Like the `pg` seam, `@fastify/static` is loaded via a LAZY, NON-LITERAL specifier so
 * tsc never resolves it at build time and the in-memory default builds/serves with the
 * plugin NOT installed. It is only required when SERVE_STATIC is set (or a built dist is
 * present), consistent with the optional-dependency story for self-host.
 */

/** API route prefixes that must NEVER be shadowed by the SPA fallback — an unknown path
 *  under one of these is a genuine JSON 404, not a client route. */
const API_PREFIXES = ['/sessions', '/api', '/preview', '/auth', '/oauth', '/health'] as const

const isApiPath = (url: string): boolean => {
  const path = url.split('?')[0] ?? url
  return API_PREFIXES.some(p => path === p || path.startsWith(p + '/'))
}

/** Resolve the built-frontend dist directory relative to the compiled sources
 *  (../../../frontend/dist from backend/src/api). Overridable for tests/hosts. */
export const defaultStaticRoot = (): string =>
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../frontend/dist')

/** Whether static serving should be active: explicit SERVE_STATIC opt-in, or auto when a
 *  built dist exists (so a single-container image just works without extra config). */
export function staticServingEnabled(env: Record<string, string | undefined>, root: string): boolean {
  if (env.SERVE_STATIC === '1' || env.SERVE_STATIC === 'true') return true
  if (env.SERVE_STATIC === '0' || env.SERVE_STATIC === 'false') return false
  return existsSync(root)
}

/**
 * Register `@fastify/static` (lazy, non-literal import) to serve `root`, plus an SPA
 * fallback via setNotFoundHandler: a GET that is NOT under an API prefix returns the
 * SPA's index.html (client-side routing); everything else (API 404s, non-GET) returns
 * the normal JSON 404. Registered inside an async plugin so Fastify resolves the lazy
 * import during ready()/first-inject; buildServer can call it synchronously.
 */
export function registerStatic(app: FastifyInstance, opts: { root: string }): void {
  const { root } = opts
  app.register(async instance => {
    const spec = '@fastify/static'
    const mod = (await import(spec)) as unknown as { default: FastifyStaticPlugin }
    // wildcard:false → @fastify/static does NOT install its own catch-all GET route, so
    // unmatched paths reach our setNotFoundHandler (where the API-aware SPA fallback lives).
    instance.register(mod.default, { root, wildcard: false })
  })

  // SPA fallback at the ROOT (so it catches deep-links that match no route): a non-API
  // GET reloads to index.html; everything else (API 404s, non-GET) gets a JSON 404. We
  // read index.html ourselves rather than reply.sendFile — that decorator lives in the
  // @fastify/static child encapsulation, not at this root scope.
  const indexHtml = join(root, 'index.html')
  app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
    if (req.method === 'GET' && !isApiPath(req.url) && existsSync(indexHtml)) {
      return reply.code(200).type('text/html; charset=utf-8').send(readFileSync(indexHtml))
    }
    return reply.code(404).send({ error: 'not found', code: 'NotFound' })
  })
}

/** Minimal structural shape of the @fastify/static default export (a Fastify plugin). It
 *  is loaded lazily/non-literally so tsc never needs its real types at build time. */
type FastifyStaticPlugin = (instance: FastifyInstance, opts: { root: string; wildcard?: boolean }) => Promise<void> | void
