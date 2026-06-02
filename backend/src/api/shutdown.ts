/**
 * Graceful shutdown for the self-host server.
 *
 * On SIGTERM (`docker stop`, orchestrator rollout) or SIGINT (Ctrl-C) the process must
 * stop accepting new connections, let in-flight requests drain, and close the Postgres
 * pool BEFORE exiting — otherwise `docker stop` cuts live requests and leaks DB
 * connections. tini (PID 1 in the image) forwards the signal, but Node still needs a
 * handler or it just hard-exits with the default disposition. A hard timeout backstop
 * forces exit so a hung drain can never wedge the container past its stop grace period.
 *
 * Everything that touches the process or the clock is injected, so the whole thing is
 * unit-testable offline with no real timers, signals, or process exit.
 */

export type ShutdownSignal = 'SIGTERM' | 'SIGINT'

/** The minimal process surface the helper needs (the real `process` satisfies it). */
interface ProcLike {
  on(event: string, listener: (...args: unknown[]) => unknown): unknown
  exit(code?: number): never
}

export interface ShutdownDeps {
  /** Ordered teardown — typically `await app.close()` then `await pool.end()`. */
  close: () => Promise<void>
  /** Signals to handle. Default: SIGTERM + SIGINT. */
  signals?: ShutdownSignal[]
  /** Force-exit deadline if the drain hangs, in ms. Default 10s. */
  timeoutMs?: number
  /** Process surface (injected in tests; defaults to the global process). */
  proc?: ProcLike
  /** Log sink (injected in tests; defaults to console.log). */
  log?: (msg: string) => void
  /** Timer fns (injected in tests; default to the globals). */
  timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout }
}

/**
 * Register signal handlers that drain via `close()` then exit. The first signal starts
 * the drain; later signals during the drain are ignored (a second Ctrl-C won't abort a
 * clean shutdown). Exits 0 on a clean drain, 1 on drain error or timeout — and exits at
 * most once (the timeout and the drain race to settle, whichever wins is final).
 */
export function installGracefulShutdown(deps: ShutdownDeps): void {
  const close = deps.close
  const signals = deps.signals ?? ['SIGTERM', 'SIGINT']
  const timeoutMs = deps.timeoutMs ?? 10_000
  const proc = deps.proc ?? (process as unknown as ProcLike)
  // eslint-disable-next-line no-console
  const log = deps.log ?? ((msg: string) => console.log(msg))
  const setTimeoutFn = deps.timers?.setTimeout ?? setTimeout
  const clearTimeoutFn = deps.timers?.clearTimeout ?? clearTimeout

  let shuttingDown = false
  let settled = false

  const handler = async (sig: unknown): Promise<void> => {
    if (shuttingDown) { log(`shutdown: already draining, ignoring ${String(sig)}`); return }
    shuttingDown = true
    log(`shutdown: received ${String(sig)}, draining in-flight work…`)

    const timer = setTimeoutFn(() => {
      if (settled) return
      settled = true
      log(`shutdown: drain exceeded ${timeoutMs}ms — forcing exit`)
      proc.exit(1)
    }, timeoutMs)

    try {
      await close()
      if (settled) return
      settled = true
      clearTimeoutFn(timer)
      log('shutdown: drain complete, exiting cleanly')
      proc.exit(0)
    } catch (err) {
      if (settled) return
      settled = true
      clearTimeoutFn(timer)
      log(`shutdown: error during drain — ${(err as Error).message}`)
      proc.exit(1)
    }
  }

  for (const sig of signals) proc.on(sig, handler)
}
