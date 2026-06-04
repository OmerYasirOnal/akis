import type { RepoFile } from '../di/MockGitHubAdapter.js'
import { detectAppType } from '../preview/AppDetector.js'
import { materialize, teardown as teardownWorkspace } from '../preview/Workspace.js'
import type { PreviewRegistry } from '../preview/PreviewRegistry.js'
import type { BootResult } from './bootSmoke.js'

/**
 * Synthetic session suffix for a VERIFY boot. The boot-smoke runner needs to start the produced
 * app to probe it, but it must NOT collide with — or stop — the user's LIVE preview (the registry
 * keys everything by sessionId; `start()` first `stop()`s any prior preview for that id). Suffixing
 * a dedicated id keeps the verify boot a SEPARATE registry entry, torn down independently.
 */
export const VERIFY_SESSION_SUFFIX = '#verify'

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
 * → `{ failed: boundedReason }`, and the workspace is cleaned up. A static preview is reported as
 * a failure here because it exposes no directly-fetchable local HTTP server (it is served only
 * THROUGH the proxy) — wiring the proxy origin for a static verify boot is deferred to a later PR.
 */
export function makePreviewBoot(registry: PreviewRegistry): (sessionId: string, files: RepoFile[]) => Promise<BootResult> {
  return async (sessionId, files) => {
    const verifyId = `${sessionId}${VERIFY_SESSION_SUFFIX}`
    const type = detectAppType(files)
    if (type === 'unsupported') return { failed: `app type '${type}' cannot be booted to verify` }

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
