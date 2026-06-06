import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, sep, extname } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { RepoFile } from '../di/MockGitHubAdapter.js'
import { detectAppType } from '../preview/AppDetector.js'
import { materialize, teardown as teardownWorkspace } from '../preview/Workspace.js'
import type { PreviewRegistry } from '../preview/PreviewRegistry.js'
import type { BootResult } from './bootSmoke.js'

/**
 * Synthetic session suffix for a VERIFY boot. The boot-smoke runner needs to start the produced
 * app to probe it, but it must NOT collide with — or stop — the user's LIVE preview (the registry
 * keys everything by sessionId; `start()` first `stop()`s any prior preview for that id). The id
 * additionally carries a PER-RUN nonce (PR #94 review): with a bare `<sessionId>#verify`, two
 * CONCURRENT verifies of the same session would share one registry key — the second `start()`
 * would silently `stop()` (kill) the first verify's booted app mid-probe and leak its workspace.
 * A unique id per run keeps every verify boot an independent entry with independent teardown.
 */
// The constant LIVES in the registry (avoids a preview↔verify import cycle); re-exported here
// for existing consumers.
import { VERIFY_SESSION_SUFFIX } from '../preview/PreviewRegistry.js'
export { VERIFY_SESSION_SUFFIX }

/**
 * Build the `boot` dependency for the boot-smoke runner from a {@link PreviewRegistry}: it
 * materializes the produced files into an ephemeral workspace, starts them under a DEDICATED
 * synthetic session id (`<sessionId>#verify`) so it never collides with the user's live preview,
 * and — on a ready preview — returns the LOCAL loopback URL the registry itself probes
 * (`http://127.0.0.1:<port>`), NOT the same-origin `/preview/:id/` proxy path (that requires the
 * Fastify proxy to be in front of it; the verifier fetches the dev server directly).
 *
 * Teardown stops the registry entry (kills the process group + releases the port) AND removes the
 * materialized workspace, so a verify boot leaves nothing behind.
 *
 * FAIL-CLOSED: any non-ready outcome (unsupported / install failed / early exit / probe timeout)
 * → `{ failed: boundedReason }`, and the workspace is cleaned up. STATIC apps (no process, no
 * port — the registry serves them only THROUGH the proxy) get a tiny throwaway loopback file
 * server over the materialized workspace instead (PR3), so the most common Proto output is
 * boot-verifiable too.
 */
export function makePreviewBoot(registry: PreviewRegistry): (sessionId: string, files: RepoFile[]) => Promise<BootResult> {
  return async (sessionId, files) => {
    const verifyId = `${sessionId}${VERIFY_SESSION_SUFFIX}-${randomBytes(4).toString('hex')}`
    const type = detectAppType(files)
    if (type === 'unsupported') return { failed: `app type '${type}' cannot be booted to verify` }

    // STATIC apps (the most common Proto output — a self-contained index.html) get a tiny
    // throwaway loopback file server over the materialized workspace (PR3): the registry's
    // static path serves only THROUGH the Fastify proxy (no own port), so without this the
    // most common build couldn't be boot-verified at all. Zero dependencies. HONEST SCOPE
    // (PR #99 review): this verifies the app's files EXIST and HTTP-SERVE (and any
    // body/criteria checks against the served bytes) — it does NOT execute JS or render in
    // a browser, so runtime correctness stays the (future) browser-tier's job.
    if (type === 'static') {
      let dir: string
      try {
        dir = await materialize(verifyId, files)
      } catch (e) {
        return { failed: `workspace materialize failed — ${boundReason(e)}` }
      }
      try {
        const server = await serveStatic(dir)
        const port = (server.address() as AddressInfo).port
        return {
          url: `http://127.0.0.1:${port}`,
          teardown: async () => {
            // Force-drop keep-alive sockets FIRST (PR #99 review): the probes' fetch() pools
            // connections, and a bare close() waits for them — teardown would hang for the
            // keep-alive timeout (or forever), wedging the verify.
            server.closeAllConnections()
            await new Promise<void>(resolveClose => server.close(() => resolveClose()))
            await teardownWorkspace(dir).catch(() => {})
          },
        }
      } catch (e) {
        await teardownWorkspace(dir).catch(() => {})
        return { failed: `static verify server failed — ${boundReason(e)}` }
      }
    }

    let dir: string
    try {
      dir = await materialize(verifyId, files)
    } catch (e) {
      return { failed: `workspace materialize failed — ${boundReason(e)}` }
    }

    let entry
    try {
      // The registry OWNS dir teardown on a non-ready outcome (it `teardown`s on failure) and on
      // `stop()` — so on failure below we don't double-remove; on success teardown goes via stop().
      entry = await registry.start(verifyId, dir, type)
    } catch (e) {
      await teardownWorkspace(dir).catch(() => {})
      return { failed: `preview start errored — ${boundReason(e)}` }
    }

    if (entry.status !== 'ready') {
      // The registry already tore the workspace down on a failed/unsupported start.
      return { failed: boundReason(entry.reason ?? `preview not ready (status ${entry.status})`) }
    }

    const port = registry.portFor(verifyId)
    if (port === undefined) {
      // Ready but no loopback port (a static preview served only through the proxy) — no directly-
      // fetchable local server to probe. Stop the entry (also tears the workspace down) + fail.
      await registry.stop(verifyId).catch(() => {})
      return { failed: 'preview has no directly-probeable local URL (static/proxy-only)' }
    }

    return {
      url: `http://127.0.0.1:${port}`,
      // Stop releases the port + kills the process group + tears the workspace down (idempotent).
      teardown: () => registry.stop(verifyId),
    }
  }
}

/** Bound a reason string for a structured failure (never free-form prose into the seam). */
function boundReason(e: unknown): string {
  return String(e instanceof Error ? e.message : e).slice(0, 200)
}

/** Just enough content-types for probe-relevant assets; everything else is octet-stream. */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

/**
 * A MINIMAL throwaway static file server over a verify workspace — loopback only, one
 * verify run's lifetime, closed in teardown. PATH-TRAVERSAL SAFE: the resolved target must
 * stay inside the root (same guard idea as Workspace.safeJoin), else 404 — the workspace
 * holds the generated app, and a probe URL is derived from the spec (LLM text), so `..`
 * escapes must be structurally impossible. `/` and directory paths fall back to index.html
 * (how the preview proxy serves a static app). 404 on a miss — under the boot-smoke rule
 * (status < 400) a missing front door honestly FAILS the probe.
 */
async function serveStatic(root: string): Promise<Server> {
  const base = resolve(root)
  const server = createServer((req, res) => {
    void (async () => {
      const rawPath = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/')
      const rel = rawPath.replace(/^\/+/, '').replace(/\/+$/, '')
      const target = resolve(base, rel === '' ? 'index.html' : rel)
      const safe = target === base || target.startsWith(base + sep)
      try {
        if (!safe) throw new Error('outside root')
        let body: Buffer
        let file = target
        try {
          body = await readFile(file)
        } catch {
          // Directory or extensionless route → index.html fallback (SPA-style), once.
          file = resolve(target, 'index.html')
          if (!file.startsWith(base + sep)) throw new Error('outside root')
          body = await readFile(file)
        }
        res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
        res.end(body)
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('not found')
      }
    })()
  })
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolveListen())
  })
  return server
}
