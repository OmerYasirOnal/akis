import type { RegisteredTool } from './ToolRegistry.js'
import type { McpSessionPool } from '../mcp/McpSessionPool.js'
import { buildGithubMcpToolsFromTransport, type McpDiagnostic } from '../mcp/McpToolBridge.js'
import { McpUnavailableError } from '../mcp/McpTransport.js'

/** The just-in-time MCP wiring deps. The caller hands the ALREADY-DECRYPTED token — this
 *  module NEVER decrypts and NEVER persists it. */
export interface GithubMcpDeps {
  pool: McpSessionPool
  ownerId: string
  /** The session owner's decrypted GitHub OAuth token (just-in-time; never logged here). */
  token: string
  /** Non-secret degrade-reason sink (names/reasons only). Defaults to console.warn. */
  diag?: McpDiagnostic
}

const defaultDiag: McpDiagnostic = msg => {
  // eslint-disable-next-line no-console
  console.warn(msg)
}

/** A no-op release — returned whenever no ref is held (no connection / acquire failed), so a
 *  caller can ALWAYS call `release()` in a finally without a presence check. Idempotent. */
const NOOP_RELEASE = (): void => {}

/** What buildGithubMcpTools returns: the bridged read tools PLUS a `release` disposer the caller
 *  MUST call once the tool LOOP that uses them has finished. The acquired refcount is held for the
 *  ENTIRE lifetime of the loop (not just the build), so the pool's idle timer can never fire and
 *  tear down the live Docker child WHILE a handler still holds the captured transport. */
export interface GithubMcpToolsResult {
  tools: RegisteredTool[]
  /** Release the held ref EXACTLY once after the tool loop completes (resolve OR reject). Calling
   *  it more than once, or when no ref was held, is a safe no-op (idempotent). */
  release: () => void
}

/**
 * The SP1 analogue of retrieveKnowledgeTool's wiring: acquire a per-(ownerId, token) transport
 * from the pool, bridge its READ-ONLY tools, and return them WITH a release disposer.
 *
 * REF-HELD-ACROSS-LOOP (findings #4/#6): the acquired ref is NOT released here. The bridged tool
 * HANDLERS capture the live transport and call it LATER, during the (async, multi-turn) tool loop
 * — a realistic Scribe draft with several github reads can exceed the 60s idle window. If we
 * released at build time the pool would arm its idle timer at refcount 0 and could close the
 * Docker child mid-loop, silently degrading the handlers to error strings. So the ref is held for
 * the loop's lifetime; the caller releases it in a finally AROUND callWithTools (ScribeAgent).
 *
 * HONEST ABSENCE, NEVER A CRASH: any error — no Docker, bad token, server start failure
 * (McpUnavailableError), a listTools failure, or an empty allow-list intersection — yields
 * `{ tools: [], release: noop }`. On the no-tools paths the ref is released IMMEDIATELY (there is
 * no loop to keep it alive for), so the pool tears the idle transport down on its normal schedule.
 * A single non-secret degrade-reason diagnostic is emitted (no token, ever). The build is
 * unaffected: the agent simply gets no github tools.
 */
export async function buildGithubMcpTools(deps: GithubMcpDeps): Promise<GithubMcpToolsResult> {
  const diag = deps.diag ?? defaultDiag
  let transport
  try {
    transport = await deps.pool.acquire(deps.ownerId, deps.token)
  } catch (e) {
    // acquire() already undid its own refcount on failure — nothing to release.
    diag(`github-mcp: tools unavailable (${reasonOf(e)})`)
    return { tools: [], release: NOOP_RELEASE }
  }
  // We now hold ONE ref. release() must run exactly once; guard against a double-call so a
  // caller's belt-and-braces double finally can never drive the refcount negative.
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    deps.pool.release(deps.ownerId, deps.token)
  }
  try {
    const tools = await buildGithubMcpToolsFromTransport(transport, diag)
    if (tools.length === 0) {
      // No tools to drive a loop ⇒ no reason to keep the ref; release NOW so the idle timer arms.
      diag('github-mcp: no read tools available (empty-intersection)')
      release()
      return { tools: [], release: NOOP_RELEASE }
    }
    // Tools exist: HOLD the ref and hand the caller the disposer to release after the loop.
    return { tools, release }
  } catch (e) {
    // Defensive: the bridge already swallows listTools failures, but never let anything escape.
    // On any escape, release the ref we hold (no loop will run) and degrade to honest absence.
    diag(`github-mcp: tools unavailable (${reasonOf(e)})`)
    release()
    return { tools: [], release: NOOP_RELEASE }
  }
}

/** Map an error to a short, NON-SECRET degrade reason. Never echoes a token or args. */
function reasonOf(e: unknown): string {
  if (e instanceof McpUnavailableError) {
    if (e.message.includes('docker')) return 'no-docker'
    return 'server-error'
  }
  return 'connection-absent'
}
