import { createHash } from 'node:crypto'
import type { McpTransport } from './McpTransport.js'

/**
 * Per-(identity, scope) lifecycle manager for MCP transports — an SP1 PROCESS-REUSE
 * OPTIMIZATION (NOT part of the portability contract). It reuses ONE initialized transport
 * per key across all of a session's tool calls, so the bounded tool loop never spawns a
 * Docker child per call; an idle key is torn down after a grace window.
 *
 * SCOPE (never conflate two owners): the key is sha256(token + ':' + ownerId) — NEVER the
 * token alone (so two distinct owners that happen to share a PAT get DIFFERENT transports),
 * and NEVER the raw token as a key (only its hash is ever held as a map key).
 *
 * CONCURRENCY: an explicit refcount. acquire() increments + cancels any armed idle timer;
 * release() decrements + arms the idle timer ONLY at refcount 0. close() of an idle key is
 * guarded — an in-flight callTool (refcount > 0) keeps the transport alive.
 *
 * initialize() + the first listTools (by the caller) happen ONCE per key; subsequent
 * acquire()s of the same key reuse the SAME transport instance.
 */

/** Builds a fresh transport for a key. Receives ONLY (ownerId) — NEVER the token-derived key,
 *  NEVER the hash. The factory closes over how to obtain the token (see services.ts). The
 *  caller (githubMcpTools) passes the token to the factory out-of-band. */
export type McpTransportFactory = (material: { ownerId: string; token: string }) => McpTransport

export interface McpSessionPoolOptions {
  factory: McpTransportFactory
  /** Idle teardown grace (ms) after the last release. Default 60_000. */
  idleMs?: number
  /** Injectable clock (tests). Default Date.now. */
  nowMs?: () => number
  /** Injectable timer (tests). Default setTimeout; must return a handle with no host coupling. */
  setTimer?: (cb: () => void, ms: number) => { cancel: () => void }
}

interface Entry {
  transport: McpTransport
  /** The shared initialize() promise — initialize runs ONCE per key, reused across acquires. */
  ready: Promise<void>
  refcount: number
  idleTimer: { cancel: () => void } | undefined
}

const defaultSetTimer = (cb: () => void, ms: number): { cancel: () => void } => {
  const h = setTimeout(cb, ms)
  if (typeof (h as { unref?: () => void }).unref === 'function') (h as { unref: () => void }).unref()
  return { cancel: () => clearTimeout(h) }
}

export class McpSessionPool {
  private readonly factory: McpTransportFactory
  private readonly idleMs: number
  private readonly setTimer: (cb: () => void, ms: number) => { cancel: () => void }
  private readonly entries = new Map<string, Entry>()

  constructor(opts: McpSessionPoolOptions) {
    this.factory = opts.factory
    this.idleMs = opts.idleMs ?? 60_000
    this.setTimer = opts.setTimer ?? defaultSetTimer
    // nowMs is reserved for future TTL policy; not needed for refcount/idle semantics.
    void opts.nowMs
  }

  /** The scope key — sha256(token + ':' + ownerId). Never the raw token; distinct owners never share. */
  private keyFor(ownerId: string, token: string): string {
    return createHash('sha256').update(`${token}:${ownerId}`).digest('hex')
  }

  /**
   * Acquire an INITIALIZED transport for (ownerId, token). The first acquire for a key builds
   * + initialize()s the transport; later acquires of the same key reuse the SAME instance and
   * await the SAME initialize() promise. Increments the refcount and cancels any armed idle timer.
   *
   * If the factory throws or initialize() rejects, the entry is removed (the pool is NOT
   * poisoned — a later acquire retries cleanly) and the error propagates to the caller, which
   * degrades to an honest absence.
   */
  async acquire(ownerId: string, token: string): Promise<McpTransport> {
    const key = this.keyFor(ownerId, token)
    let entry = this.entries.get(key)
    if (!entry) {
      const transport = this.factory({ ownerId, token })
      const fresh: Entry = { transport, ready: transport.initialize(), refcount: 0, idleTimer: undefined }
      this.entries.set(key, fresh)
      entry = fresh
    }
    // Cancel any pending idle teardown — this key is in use again.
    if (entry.idleTimer) {
      entry.idleTimer.cancel()
      entry.idleTimer = undefined
    }
    entry.refcount++
    try {
      await entry.ready
    } catch (e) {
      // Failed initialize ⇒ don't poison the pool. Undo our refcount and drop the entry so a
      // later acquire retries with a fresh transport.
      entry.refcount--
      if (this.entries.get(key) === entry) this.entries.delete(key)
      throw e
    }
    return entry.transport
  }

  /**
   * Release a previously acquired transport for (ownerId, token). Decrements the refcount;
   * when it reaches 0, ARMS the idle timer — close() happens only after the grace window with
   * the refcount still at 0 (a re-acquire in the window cancels it).
   */
  release(ownerId: string, token: string): void {
    const key = this.keyFor(ownerId, token)
    const entry = this.entries.get(key)
    if (!entry) return
    if (entry.refcount > 0) entry.refcount--
    if (entry.refcount > 0) return // still in use — keep alive
    // Arm idle teardown. If re-acquired before it fires, acquire() cancels it.
    entry.idleTimer = this.setTimer(() => {
      const cur = this.entries.get(key)
      if (!cur || cur !== entry) return // replaced/removed meanwhile
      if (cur.refcount > 0) return // re-acquired in a race — keep alive
      this.entries.delete(key)
      void cur.transport.close().catch(() => {}) // best-effort
    }, this.idleMs)
  }

  /**
   * Close EVERY live transport (graceful shutdown). Idempotent + best-effort: a hung docker-kill
   * cannot block the caller (each close is fire-and-forget-awaited with errors swallowed).
   */
  async closeAll(): Promise<void> {
    const entries = [...this.entries.values()]
    this.entries.clear()
    await Promise.all(
      entries.map(async e => {
        if (e.idleTimer) {
          e.idleTimer.cancel()
          e.idleTimer = undefined
        }
        try {
          await e.transport.close()
        } catch {
          /* best-effort */
        }
      }),
    )
  }
}
